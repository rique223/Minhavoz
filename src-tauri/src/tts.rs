//! Piper TTS wrapper. Given text + a model path, produce WAV bytes; audio
//! playback happens in the WebView2 frontend (HTMLAudioElement + setSinkId).
//!
//! For low latency we keep ONE piper process warm (`--json-input` mode) instead
//! of spawning it per utterance: piper loads the model once, then we feed it a
//! JSON line per request and it echoes the finished `output_file` path back on
//! stdout. We also disk-cache synthesized WAVs so repeated text (quick phrases,
//! retries) is instant — even across app restarts.

use std::collections::hash_map::DefaultHasher;
use std::collections::VecDeque;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::{Arc, Mutex, OnceLock};
use std::thread;
use tauri::Manager;

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

/// Keep at most this many cached WAVs on disk before pruning the oldest.
const DISK_CACHE_CAP: usize = 500;

/// The single warm piper process, lazily spawned. `None` until first use or
/// after a failure/voice-change forces a respawn. piper self-terminates when
/// our stdin handle drops (i.e. when the app exits), so no explicit teardown.
fn piper_slot() -> &'static Mutex<Option<WarmPiper>> {
    static PIPER: OnceLock<Mutex<Option<WarmPiper>>> = OnceLock::new();
    PIPER.get_or_init(|| Mutex::new(None))
}

struct WarmPiper {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    /// Last few stderr lines, drained by a background thread so a crash has a
    /// human-readable cause without risking a pipe deadlock on the read path.
    stderr_tail: Arc<Mutex<VecDeque<String>>>,
    model: PathBuf,
    length_scale: f32,
}

// ---- resource paths -------------------------------------------------------

/// Base dir containing the `piper/` and `voices/` folders. Debug resolves from
/// the crate's `resources/`; release uses Tauri's bundled resource dir.
fn resource_base(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    if cfg!(debug_assertions) {
        Ok(PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("resources"))
    } else {
        app.path()
            .resource_dir()
            .map_err(|e| format!("could not resolve resource dir: {e}"))
    }
}

fn piper_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(resource_base(app)?.join("piper"))
}

/// Piper's config convention: `<model>.onnx` -> `<model>.onnx.json`.
fn config_path(model: &Path) -> PathBuf {
    let mut s = model.as_os_str().to_owned();
    s.push(".json");
    PathBuf::from(s)
}

/// Resolve + validate the voice model. A configured path wins if set; otherwise
/// the bundled cadu voice. Surrounding quotes/whitespace (e.g. from Windows
/// "Copy as path") are stripped, and we verify the companion `.onnx.json` exists
/// so a missing config fails with a clear message instead of a blank piper error.
fn resolve_model(app: &tauri::AppHandle, model_path: Option<String>) -> Result<PathBuf, String> {
    if let Some(raw) = model_path {
        let cleaned = raw.trim().trim_matches('"').trim();
        if !cleaned.is_empty() {
            let pb = PathBuf::from(cleaned);
            if !pb.exists() {
                return Err(format!("voice model not found at: {}", pb.display()));
            }
            let cfg = config_path(&pb);
            if !cfg.exists() {
                return Err(format!(
                    "voice config missing: Piper needs \"{}\" right next to the model. \
                     Download the matching .onnx.json and place it beside the .onnx file.",
                    cfg.display()
                ));
            }
            return Ok(pb);
        }
    }
    let def = resource_base(app)?
        .join("voices")
        .join("pt_BR-cadu-medium.onnx");
    if def.exists() {
        Ok(def)
    } else {
        Err(format!(
            "bundled default voice model missing at {}",
            def.display()
        ))
    }
}

// ---- disk cache -----------------------------------------------------------

fn cache_dir(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    let d = app
        .path()
        .app_cache_dir()
        .map_err(|e| format!("could not resolve cache dir: {e}"))?
        .join("tts");
    std::fs::create_dir_all(&d).map_err(|e| format!("could not create cache dir: {e}"))?;
    Ok(d)
}

/// Stable filename for a (model, rate, text) triple. DefaultHasher::new() uses
/// fixed keys, so the same input maps to the same file across runs.
fn cache_file(dir: &Path, model: &Path, ls: f32, text: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    model.to_string_lossy().hash(&mut h);
    format!("{ls:.4}").hash(&mut h);
    text.hash(&mut h);
    dir.join(format!("{:016x}.wav", h.finish()))
}

/// Drop the oldest files once the cache exceeds the cap. Best-effort.
fn prune_cache(dir: &Path) {
    let mut entries: Vec<(PathBuf, std::time::SystemTime)> = match std::fs::read_dir(dir) {
        Ok(rd) => rd
            .flatten()
            .filter_map(|e| {
                let m = e.metadata().ok()?.modified().ok()?;
                Some((e.path(), m))
            })
            .collect(),
        Err(_) => return,
    };
    if entries.len() <= DISK_CACHE_CAP {
        return;
    }
    entries.sort_by_key(|(_, m)| *m);
    let overflow = entries.len() - DISK_CACHE_CAP;
    for (p, _) in entries.into_iter().take(overflow) {
        let _ = std::fs::remove_file(p);
    }
}

// ---- warm piper -----------------------------------------------------------

fn spawn_warm(dir: &Path, model: &Path, ls: f32) -> Result<WarmPiper, String> {
    let exe = dir.join("piper.exe");
    if !exe.exists() {
        return Err(format!("piper binary missing at {}", exe.display()));
    }

    let mut cmd = Command::new(&exe);
    // current_dir = piper folder so espeak-ng-data / DLLs resolve next to the exe.
    cmd.current_dir(dir)
        .arg("--model")
        .arg(model)
        .arg("--json-input")
        .arg("--length_scale")
        .arg(ls.to_string())
        .arg("--quiet")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    cmd.creation_flags(CREATE_NO_WINDOW);

    let mut child = cmd
        .spawn()
        .map_err(|e| format!("failed to launch piper: {e}"))?;
    let stdin = child.stdin.take().ok_or("could not open piper stdin")?;
    let stdout = BufReader::new(child.stdout.take().ok_or("could not open piper stdout")?);
    let stderr = child.stderr.take().ok_or("could not open piper stderr")?;

    let stderr_tail = Arc::new(Mutex::new(VecDeque::<String>::new()));
    {
        let tail = stderr_tail.clone();
        thread::spawn(move || {
            for line in BufReader::new(stderr).lines().map_while(Result::ok) {
                if let Ok(mut t) = tail.lock() {
                    t.push_back(line);
                    while t.len() > 10 {
                        t.pop_front();
                    }
                }
            }
        });
    }

    Ok(WarmPiper {
        child,
        stdin,
        stdout,
        stderr_tail,
        model: model.to_path_buf(),
        length_scale: ls,
    })
}

/// Feed one request to a warm piper and block until it reports the WAV is done.
/// Borrows the process exclusively; on EOF/IO error returns a descriptive error
/// (including drained stderr) and the caller drops the process to force respawn.
fn run_request(w: &mut WarmPiper, text: &str, cfile: &Path) -> Result<(), String> {
    let req = serde_json::json!({
        "text": text,
        "output_file": cfile.to_string_lossy(),
    });
    w.stdin
        .write_all(format!("{req}\n").as_bytes())
        .and_then(|_| w.stdin.flush())
        .map_err(|e| format!("failed writing to piper: {e}"))?;

    // Only one request is ever in flight (callers hold the slot lock), so the
    // next stdout line that ends with our filename is this request's completion.
    let filename = cfile
        .file_name()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default();
    loop {
        let mut buf = String::new();
        let n = w
            .stdout
            .read_line(&mut buf)
            .map_err(|e| format!("failed reading piper output: {e}"))?;
        if n == 0 {
            let tail = w
                .stderr_tail
                .lock()
                .map(|t| t.iter().cloned().collect::<Vec<_>>().join("; "))
                .unwrap_or_default();
            let code = w.child.try_wait().ok().flatten().and_then(|s| s.code());
            return Err(format!(
                "piper exited (code {code:?}) mid-synthesis: {}",
                if tail.is_empty() {
                    "<no stderr output>".to_string()
                } else {
                    tail
                }
            ));
        }
        if buf.trim().ends_with(&filename) {
            return Ok(());
        }
    }
}

// ---- public entry point ---------------------------------------------------

/// Synthesize `text` to WAV bytes. Hits the disk cache first; otherwise drives
/// the warm piper. `length_scale` maps to piper's --length_scale (>1 slower).
pub fn synthesize(
    app: &tauri::AppHandle,
    text: &str,
    model_path: Option<String>,
    length_scale: Option<f32>,
) -> Result<Vec<u8>, String> {
    let ls = length_scale.unwrap_or(1.0);
    let model = resolve_model(app, model_path)?;
    let dir = piper_dir(app)?;
    let cdir = cache_dir(app)?;
    let cfile = cache_file(&cdir, &model, ls, text);

    // L2 cache: a previously synthesized WAV on disk.
    if let Ok(bytes) = std::fs::read(&cfile) {
        if bytes.len() >= 44 {
            return Ok(bytes);
        }
    }

    let mut guard = piper_slot()
        .lock()
        .map_err(|_| "piper state poisoned".to_string())?;

    // Respawn if the voice or rate changed (piper bakes both in at launch).
    let stale = match guard.as_ref() {
        Some(w) => w.model != model || (w.length_scale - ls).abs() > f32::EPSILON,
        None => true,
    };
    if stale {
        if let Some(mut old) = guard.take() {
            let _ = old.child.kill();
            let _ = old.child.wait();
        }
        *guard = Some(spawn_warm(&dir, &model, ls)?);
    }

    // Run the request; on failure drop the process so the next call respawns.
    let result = run_request(guard.as_mut().expect("just ensured Some"), text, &cfile);
    if let Err(e) = result {
        *guard = None;
        return Err(e);
    }
    drop(guard);

    let bytes = std::fs::read(&cfile)
        .map_err(|e| format!("could not read piper output {}: {e}", cfile.display()))?;
    if bytes.len() < 44 {
        return Err("piper produced no audio (empty WAV)".into());
    }
    prune_cache(&cdir);
    Ok(bytes)
}
