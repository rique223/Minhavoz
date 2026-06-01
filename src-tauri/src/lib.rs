mod openai;
mod secrets;
mod tts;

use tauri::{
    menu::{Menu, MenuItem},
    tray::TrayIconBuilder,
    Manager, WindowEvent,
};

/// Synthesize `text` with Piper and return the raw WAV bytes to the frontend.
/// Raw bytes (not base64 JSON) via `tauri::ipc::Response` keep latency low; the
/// frontend wraps them in a Blob and plays via HTMLAudioElement + setSinkId().
#[tauri::command]
async fn speak(
    app: tauri::AppHandle,
    text: String,
    model_path: Option<String>,
    length_scale: Option<f32>,
) -> Result<tauri::ipc::Response, String> {
    let bytes = tauri::async_runtime::spawn_blocking(move || {
        tts::synthesize(&app, &text, model_path, length_scale)
    })
    .await
    .map_err(|e| format!("synthesis task failed to run: {e}"))??;
    Ok(tauri::ipc::Response::new(bytes))
}

/// Stream OpenAI TTS audio (MP3) to the frontend over `on_chunk`. The API key is
/// read from the OS keychain here so it never crosses IPC from the frontend. On
/// failure the typed `TtsError` lets the frontend decide whether to latch onto
/// Piper (auth/quota/network) or just retry (other).
#[tauri::command]
async fn speak_openai(
    app: tauri::AppHandle,
    on_chunk: tauri::ipc::Channel<tauri::ipc::InvokeResponseBody>,
    text: String,
    voice: String,
    instructions: String,
    model: String,
) -> Result<(), openai::TtsError> {
    let key = secrets::get_api_key("openai")
        .ok_or_else(|| openai::TtsError::new("auth", "no OpenAI API key saved"))?;
    openai::synthesize_stream(app, on_chunk, key, text, voice, instructions, model).await
}

/// Bring the main window to the foreground (used by the tray menu and by the
/// single-instance hook when a relaunch / global hotkey wants to focus us).
fn show_main(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.unminimize();
        let _ = w.set_focus();
    }
}

// ---- autostart (Windows Scheduled Task) ----------------------------------
//
// A plain HKCU `Run` entry (what tauri-plugin-autostart uses) does NOT work for
// minhavoz: the app requires elevation, and Windows refuses to show a UAC prompt
// during sign-in, so the Run entry is silently skipped at logon. The standard
// workaround for auto-starting an elevated app is a logon-triggered Scheduled
// Task with "Run with highest privileges" (RL=HIGHEST), which launches us
// elevated at login with no prompt. We already run as admin, so we have the
// rights to create/delete it via schtasks.
#[cfg(windows)]
const AUTOSTART_TASK: &str = "minhavoz-autostart";

#[cfg(windows)]
fn run_schtasks(args: &[&str]) -> std::io::Result<std::process::Output> {
    use std::os::windows::process::CommandExt;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    std::process::Command::new("schtasks")
        .args(args)
        .creation_flags(CREATE_NO_WINDOW)
        .output()
}

/// Create (or remove) the logon Scheduled Task that auto-starts minhavoz elevated.
#[tauri::command]
fn autostart_set(enabled: bool) -> Result<(), String> {
    #[cfg(windows)]
    {
        if enabled {
            let exe = std::env::current_exe().map_err(|e| format!("can't find own exe: {e}"))?;
            // Quote the path so a spaced install dir still parses as one token.
            let tr = format!("\"{}\"", exe.display());
            let out = run_schtasks(&[
                "/Create", "/F", "/TN", AUTOSTART_TASK, "/SC", "ONLOGON", "/RL", "HIGHEST", "/TR",
                &tr,
            ])
            .map_err(|e| format!("schtasks failed to launch: {e}"))?;
            if !out.status.success() {
                let err = String::from_utf8_lossy(&out.stderr);
                return Err(format!("schtasks /Create failed: {}", err.trim()));
            }
        } else {
            // Best-effort delete; a missing task is fine.
            let _ = run_schtasks(&["/Delete", "/F", "/TN", AUTOSTART_TASK]);
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        let _ = enabled;
        Err("autostart is only implemented on Windows".into())
    }
}

/// Whether the autostart Scheduled Task currently exists.
#[tauri::command]
fn autostart_is_enabled() -> bool {
    #[cfg(windows)]
    {
        run_schtasks(&["/Query", "/TN", AUTOSTART_TASK])
            .map(|o| o.status.success())
            .unwrap_or(false)
    }
    #[cfg(not(windows))]
    {
        false
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let mut builder = tauri::Builder::default();

    // Single-instance MUST be the first plugin: a second launch (or relaunch from
    // the installer / hotkey) just focuses the already-running window.
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            show_main(app);
        }));
    }

    builder
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_global_shortcut::Builder::new().build())
        .invoke_handler(tauri::generate_handler![
            speak,
            speak_openai,
            secrets::set_api_key,
            secrets::has_api_key,
            secrets::delete_api_key,
            autostart_set,
            autostart_is_enabled
        ])
        .setup(|app| {
            // Tray icon with a minimal menu. Closing the window hides to tray
            // (see on_window_event); the tray is how you get back / truly quit.
            let show_i = MenuItem::with_id(app, "show", "Show minhavoz", true, None::<&str>)?;
            let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
            let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

            let _tray = TrayIconBuilder::new()
                .icon(app.default_window_icon().unwrap().clone())
                .tooltip("minhavoz")
                .menu(&menu)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "show" => show_main(app),
                    "quit" => app.exit(0),
                    _ => {}
                })
                .build(app)?;

            Ok(())
        })
        .on_window_event(|window, event| {
            // X / close = hide to tray, not exit. Quit lives in the tray menu.
            if let WindowEvent::CloseRequested { api, .. } = event {
                let _ = window.hide();
                api.prevent_close();
            }
        })
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
