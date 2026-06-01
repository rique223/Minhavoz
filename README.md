# minhavoz

Type text, press Enter, and an offline AI voice (Piper TTS) speaks it aloud into a
chosen audio **output** device. Point that output at **VB-CABLE** and your synthesized
speech becomes your "microphone" in Discord / Slack / Meet / etc.

Built for a temporary loss of voice (e.g. wisdom-teeth recovery). Windows only.
Brazilian-Portuguese voice by default (`pt_BR-cadu-medium`), swappable.

---

## How the audio routing works

```
[ you type ] → Piper TTS (Rust) → WAV bytes → WebView2 frontend
                                                   │ HTMLAudioElement.setSinkId()
                                                   ▼
                                       "CABLE Input (VB-Audio Virtual Cable)"
                                                   │  (the virtual cable)
                                                   ▼
                              Discord mic = "CABLE Output (VB-Audio Virtual Cable)"
```

The app does **not** create the virtual microphone. It only *plays* audio into whatever
output device you pick. VB-CABLE provides the loopback that turns that output back into
a selectable microphone.

---

## 1. Install VB-CABLE

1. Download VB-CABLE from <https://vb-audio.com/Cable/> (free, donationware).
2. Unzip, right-click `VBCABLE_Setup_x64.exe` → **Run as administrator** → *Install Driver*.
3. Reboot if it asks.
4. After install you'll have two new Windows audio endpoints:
   - **CABLE Input (VB-Audio Virtual Cable)** — an *output* device (this is where minhavoz plays).
   - **CABLE Output (VB-Audio Virtual Cable)** — an *input* device (this is what Discord uses as a mic).

## 2. Point minhavoz at the cable

1. Launch minhavoz.
2. Click the **⚙ Settings** button.
3. In the **Output (→ call)** dropdown, select **CABLE Input (VB-Audio Virtual Cable)**.
   The choice is remembered **by label** across restarts; if that device ever
   disappears the app warns you loudly instead of silently falling back to speakers.
4. Optional: keep **Monitor (→ you)** on to also hear the audio on your own
   headphones while it broadcasts into the cable.

> If the dropdown shows generic names like "Output 1" with no friendly labels, Windows
> hasn't granted microphone permission yet — see *Troubleshooting* below. The labels are
> needed to recognise "CABLE Input".

## 3. Select the cable as your mic in Discord

1. Discord → **User Settings → Voice & Video**.
2. **Input Device** → **CABLE Output (VB-Audio Virtual Cable)**.
3. Speak a test line in minhavoz; Discord's mic test bar should move.
4. Recommended: set Discord **Input Sensitivity** to manual and nudge the threshold low,
   or use Push-to-Talk, so silence between phrases doesn't gate your synthesized speech.

Same idea for Slack / Google Meet / Zoom / OBS — pick **CABLE Output** as the microphone.

---

## Everyday use

- **Type + Enter** → speaks immediately. **Shift+Enter** = newline. The input clears
  and refocuses after each send so you can keep typing.
- **Barge-in:** pressing Enter again interrupts whatever is currently playing and
  speaks the new line — there's no queue, the latest line always wins.
- **Esc** = panic stop: instantly halts both the cable and the monitor.
- **Quick phrases:** one-click canned replies (editable in Settings). They're
  pre-synthesized on startup so they play with zero delay.
- **Global hotkey** (default **Ctrl+Shift+Space**, rebindable in Settings) brings the
  window to the front and focuses the input from anywhere — handy mid-call.
- **Tray:** closing the window (X) hides it to the system tray; the broadcast keeps
  working. Use the tray menu to **Show** it again or **Quit** for real.
- **Settings** (⚙) persist across restarts: output/monitor devices, rate, volume,
  voice model path, quick phrases, hotkey, keep-on-top, and start-on-login.

---

## Voice models — where they live and how to swap

Bundled default: `src-tauri/resources/voices/pt_BR-cadu-medium.onnx` (+ `.onnx.json`).

Each Piper voice is **two files**: `NAME.onnx` (the model) and `NAME.onnx.json` (its config).
You need both, and they must be the matching pair.

To swap voices:

1. Download a voice from the Piper voices repo:
   <https://huggingface.co/rhasspy/piper-voices> (browse by language, e.g. `pt/pt_BR/...`).
   Grab both the `.onnx` and the `.onnx.json`.
2. Either drop the pair next to the default in `resources/voices/`, **or** point the
   **Voice model path** setting at the `.onnx` file anywhere on disk.

Voices come in `low` / `medium` / `high` quality. `medium` is the recommended balance.

---

## Build & run (developers)

### Prerequisites
- **Node.js** 18+ and npm
- **Rust** (stable, MSVC toolchain): install via <https://rustup.rs> → `rustup default stable-msvc`
- **Visual Studio Build Tools** with the *Desktop development with C++* workload (MSVC linker + Windows SDK)
- **WebView2 Runtime** (preinstalled on current Windows 11; otherwise from Microsoft)

### Dev loop
```powershell
npm install
npm run tauri dev      # launches the app with hot-reload frontend
```

### Production build (installer)
```powershell
npm run tauri build    # produces an .msi / .exe installer under src-tauri/target/release/bundle
```

The Piper binary folder (`resources/piper/`) and the voice models (`resources/voices/`)
are bundled via `bundle.resources` in `src-tauri/tauri.conf.json`.

---

## Project layout

| Path | What |
|---|---|
| `src/` | React + TS frontend (device enumeration, setSinkId playback, UI) |
| `src/audio.ts` | Device label-unlock, enumeration, setSinkId play path, tone generator |
| `src-tauri/src/tts.rs` | Thin Piper wrapper: text → WAV bytes (no audio playback in Rust) |
| `src-tauri/src/lib.rs` | `speak` Tauri command (returns raw WAV bytes) |
| `src-tauri/resources/piper/` | Bundled piper.exe + DLLs + espeak-ng-data |
| `src-tauri/resources/voices/` | Bundled voice model(s) |

---

## Troubleshooting

- **Dropdown has no friendly device names.** `enumerateDevices()` hides labels until
  microphone permission is granted. minhavoz calls `getUserMedia({audio:true})` once on
  startup to unlock them. If Windows/WebView2 denied it, allow microphone access for the
  app and click **↻ Devices**.
- **"CABLE Input" isn't in the list.** VB-CABLE isn't installed (or needs a reboot). See step 1.
- **My voice goes to my speakers, not the call.** The selected output device changed/
  re-enumerated. Re-pick **CABLE Input** and click **↻ Devices**.
- **Discord doesn't hear me.** Confirm Discord input = **CABLE Output**, and that
  minhavoz output = **CABLE Input** (easy to mix up Input/Output).
- **Global hotkey doesn't work inside some games (e.g. League of Legends) but works
  in others (e.g. Diablo 4).** Windows UIPI blocks a normal-privilege app from
  receiving a global hotkey while an **elevated** window is focused. Games with
  kernel anti-cheat (LoL + Riot Vanguard) run elevated; Diablo 4 doesn't. minhavoz
  ships with a `requireAdministrator` manifest so it always launches elevated and the
  hotkey fires over such games — expect a **UAC prompt at launch**. Also set the game
  to **Borderless** so the window can surface over it when the hotkey fires.
- **"Start on Windows login".** Because the app requires elevation, a normal HKCU
  `Run` entry is skipped at login (Windows won't show a UAC prompt during sign-in).
  So the toggle instead creates a **Scheduled Task** named `minhavoz-autostart`
  (logon-triggered, *Run with highest privileges*), which launches minhavoz elevated
  at sign-in with no prompt. Turning it off deletes the task. Inspect it in **Task
  Scheduler**, or from a terminal: `schtasks /Query /TN minhavoz-autostart`.

## Caveats hit during development

- **Piper has no official standalone Windows binary on the new repo.** The current
  `OHF-Voice/piper1-gpl` ships Python wheels only. We bundle the older but
  self-contained `rhasspy/piper` `piper_windows_amd64` build instead — same `.onnx`
  voice format. It's a multi-file binary (piper.exe + onnxruntime.dll +
  piper_phonemize.dll + espeak-ng.dll + `espeak-ng-data/`), so it's bundled as a
  **resource folder**, not a Tauri sidecar.
- **piper.exe must run with its own folder as the working directory** or it can't
  find `espeak-ng-data` / its DLLs. `tts.rs` sets `current_dir` to the piper folder.
- **`setSinkId()` works from Tauri's WebView2**, but only after device labels are
  unlocked — `enumerateDevices()` returns blank labels until `getUserMedia({audio:true})`
  has been granted once. We unlock on startup and re-resolve the saved output **by
  label** on every `devicechange` (Windows reshuffles deviceIds across reboots).
- **Selecting CABLE Input sends audio to the cable, not your speakers.** That's the
  whole point, but it means you won't hear yourself — hence the **Monitor** toggle,
  which plays a second copy to your headphones in parallel.
- **The app is never the microphone.** It only *plays* into an output device;
  VB-CABLE is what turns that into a selectable mic. No VB-CABLE installed → nothing
  shows up in Discord (not an app bug).
- **Dev-vs-release resource paths differ.** In debug, `tts.rs` reads from
  `resources/` next to the crate; in release it uses Tauri's bundled `resource_dir()`.
  Verify a real `npm run tauri build` actually copies the nested `espeak-ng-data/`
  before shipping an installer.
- **Tauri v2 JS→Rust arg names are auto-camelCased:** the Rust `model_path` /
  `length_scale` params are passed as `modelPath` / `lengthScale` from `invoke`.
- **single-instance must be the first plugin registered**, or focusing the existing
  window on relaunch won't work.
- **Forced elevation (`requireAdministrator`) is embedded via a custom manifest in
  `build.rs`** (`tauri_build::WindowsAttributes::app_manifest`). It fully replaces
  Tauri's default manifest, so it must also re-declare DPI awareness, long-path,
  Win10/11 compat, and common-controls. Consequence: `cargo run` / `tauri dev` from a
  **non-elevated** terminal can't launch the exe (CreateProcess fails with "elevation
  required") — run the dev command from an elevated terminal, or test the release exe.
- **Autostart can't use the HKCU `Run` key** (so `tauri-plugin-autostart` was dropped).
  An elevated app's `Run` entry is skipped at logon because Windows won't UAC-prompt
  during sign-in. Instead a logon **Scheduled Task** with *Run with highest privileges*
  is created/removed via `schtasks` from a small Rust command — it launches elevated
  at login with no prompt.
