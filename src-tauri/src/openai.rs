//! OpenAI TTS (gpt-4o-mini-tts) streaming.
//!
//! Streams MP3 bytes to a Tauri `Channel` as they arrive from the API so the
//! frontend can feed them into a MediaSource and start playing with minimal
//! first-audio latency. Channel messages are strictly ordered, so we send the
//! audio as `Raw` chunks (delivered to JS as ArrayBuffers) followed by a single
//! JSON `"end"` sentinel that tells the player to close the stream.
//!
//! Completed clips are disk-cached (keyed by model+voice+instructions+text) so a
//! repeat or a prewarmed quick phrase replays instantly — even across restarts —
//! without a network call or spend.

use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::OnceLock;

use futures_util::StreamExt;
use serde::Serialize;
use tauri::ipc::{Channel, InvokeResponseBody};
use tauri::Manager;

const ENDPOINT: &str = "https://api.openai.com/v1/audio/speech";
/// Stream out in modest slices so the player starts quickly and stays responsive.
const REPLAY_CHUNK: usize = 16 * 1024;

/// Structured error so the frontend can decide whether to latch onto Piper.
/// `kind`: "auth" | "quota" | "network" | "other".
#[derive(Serialize, Clone)]
pub struct TtsError {
    pub kind: String,
    pub message: String,
}

impl TtsError {
    pub fn new(kind: &str, message: impl Into<String>) -> Self {
        Self {
            kind: kind.to_string(),
            message: message.into(),
        }
    }
}

/// One reused client for HTTP keep-alive (notably cuts TLS handshake latency on
/// back-to-back sentences).
fn client() -> &'static reqwest::Client {
    static CLIENT: OnceLock<reqwest::Client> = OnceLock::new();
    CLIENT.get_or_init(reqwest::Client::new)
}

fn cache_dir(app: &tauri::AppHandle) -> Option<PathBuf> {
    let d = app.path().app_cache_dir().ok()?.join("tts-openai");
    std::fs::create_dir_all(&d).ok()?;
    Some(d)
}

fn cache_file(dir: &Path, model: &str, voice: &str, instr: &str, text: &str) -> PathBuf {
    let mut h = DefaultHasher::new();
    model.hash(&mut h);
    voice.hash(&mut h);
    instr.hash(&mut h);
    text.hash(&mut h);
    dir.join(format!("{:016x}.mp3", h.finish()))
}

fn send_raw(ch: &Channel<InvokeResponseBody>, bytes: Vec<u8>) -> Result<(), TtsError> {
    ch.send(InvokeResponseBody::Raw(bytes))
        .map_err(|e| TtsError::new("other", format!("channel send failed: {e}")))
}

/// Tell the frontend player no more audio is coming for this utterance.
fn send_end(ch: &Channel<InvokeResponseBody>) -> Result<(), TtsError> {
    ch.send(InvokeResponseBody::Json("\"end\"".into()))
        .map_err(|e| TtsError::new("other", format!("channel send failed: {e}")))
}

pub async fn synthesize_stream(
    app: tauri::AppHandle,
    on_chunk: Channel<InvokeResponseBody>,
    api_key: String,
    text: String,
    voice: String,
    instructions: String,
    model: String,
) -> Result<(), TtsError> {
    let cdir = cache_dir(&app);
    let cfile = cdir
        .as_ref()
        .map(|d| cache_file(d, &model, &voice, &instructions, &text));

    // L2 cache: replay a previously synthesized clip with no network call. Send
    // it in chunks so the frontend player path is identical to a live stream.
    if let Some(cf) = &cfile {
        if let Ok(bytes) = std::fs::read(cf) {
            if bytes.len() > 4 {
                for part in bytes.chunks(REPLAY_CHUNK) {
                    send_raw(&on_chunk, part.to_vec())?;
                }
                return send_end(&on_chunk);
            }
        }
    }

    let mut body = serde_json::json!({
        "model": model,
        "input": text,
        "voice": voice,
        "response_format": "mp3",
    });
    if !instructions.trim().is_empty() {
        body["instructions"] = serde_json::Value::String(instructions);
    }

    let resp = client()
        .post(ENDPOINT)
        .bearer_auth(&api_key)
        .json(&body)
        .send()
        .await
        .map_err(|e| TtsError::new("network", format!("request failed: {e}")))?;

    let status = resp.status();
    if !status.is_success() {
        let code = status.as_u16();
        let detail = resp.text().await.unwrap_or_default();
        let kind = match code {
            401 | 403 => "auth",
            429 => "quota",
            500..=599 => "network",
            _ => "other",
        };
        let snippet: String = detail.chars().take(300).collect();
        return Err(TtsError::new(kind, format!("OpenAI {code}: {snippet}")));
    }

    let mut stream = resp.bytes_stream();
    let mut assembled: Vec<u8> = Vec::new();
    while let Some(item) = stream.next().await {
        let bytes = item.map_err(|e| TtsError::new("network", format!("stream error: {e}")))?;
        assembled.extend_from_slice(&bytes);
        send_raw(&on_chunk, bytes.to_vec())?;
    }

    if assembled.len() <= 4 {
        return Err(TtsError::new("other", "OpenAI returned no audio"));
    }
    // Best-effort cache write for instant replay next time.
    if let Some(cf) = &cfile {
        let _ = std::fs::write(cf, &assembled);
    }
    send_end(&on_chunk)
}
