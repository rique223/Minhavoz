import { useEffect, useRef, useState } from "react";
import { invoke, Channel } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  register,
  unregister,
  isRegistered,
} from "@tauri-apps/plugin-global-shortcut";
import { open } from "@tauri-apps/plugin-dialog";
import {
  listOutputDevices,
  makeToneWavBlob,
  MseStreamPlayer,
  playToDevice,
  supportsSetSinkId,
  unlockDeviceLabels,
  type OutputDevice,
} from "./audio";
import {
  DEFAULTS,
  loadSettings,
  OPENAI_VOICES,
  saveSettings,
  type OpenAiConfig,
  type PiperConfig,
  type Provider,
  type Settings,
} from "./settings";
import { BlobCache, cacheKey } from "./cache";

/** Error shape returned by the Rust `speak_openai` command. */
type TtsError = { kind?: string; message?: string };
/** auth/quota/network are persistent enough to latch onto Piper for the session. */
const isLatchable = (k?: string) =>
  k === "auth" || k === "quota" || k === "network";

// Cache-key fragments per engine. These are independent namespaces so a Piper
// clip (e.g. produced by the sticky fallback while provider is still "openai")
// can never be mistaken for an OpenAI clip and vice-versa.
function piperVariant(s: Settings): string {
  return `piper|${s.piper.voiceModelPath}|${s.piper.lengthScale}`;
}
function openaiVariant(s: Settings): string {
  return `openai|${s.openai.model}|${s.openai.voice}|${s.openai.instructions}`;
}
import "./App.css";

const msg = (e: unknown) => (e instanceof Error ? e.message : String(e));

// Piper `length_scale`: higher = SLOWER. Wide range so the rate can be pushed to
// comedic extremes (a near-frozen drawl, or a chipmunk sprint).
const RATE_MIN = 0.2;
const RATE_MAX = 10;
// The slider runs in LOG space — a 50× range is hopelessly bunched on a linear
// track (everything < 2 piles into the first sliver). Log spacing puts
// 0.25·0.5·1·2·5·10 at even intervals, which also survives a narrow window.
const LOG_MIN = Math.log10(RATE_MIN);
const LOG_MAX = Math.log10(RATE_MAX);
const toLog = (v: number) => Math.log10(v);
const fromLog = (l: number) => Math.pow(10, l);
const ratePct = (v: number) => ((toLog(v) - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 100;

// All guides are magnetic snap detents + tick marks; only `label`-flagged ones
// print their number, so a small window stays readable.
const RATE_GUIDES: { v: number; label?: boolean }[] = [
  { v: 0.25, label: true },
  { v: 0.5, label: true },
  { v: 0.75 },
  { v: 1.0, label: true },
  { v: 1.5 },
  { v: 2.0, label: true },
  { v: 3.0 },
  { v: 5.0, label: true },
  { v: 7.0 },
  { v: 10.0, label: true },
];
// Snap when the dragged value lands within a small LOG distance of a guide, so
// the catch window feels even at both the fast and slow ends of the track.
function snapRate(v: number): number {
  const lv = toLog(v);
  let best = v;
  let bestGap = Infinity;
  for (const { v: g } of RATE_GUIDES) {
    const gap = Math.abs(lv - toLog(g));
    if (gap <= 0.035 && gap < bestGap) {
      best = g;
      bestGap = gap;
    }
  }
  return best;
}

// Split text into sentence-ish chunks so the first words can start playing while
// the rest still synthesizes. Breaks after . ! ? … and on newlines; falls back
// to the whole text when there's nothing to split.
function splitSentences(text: string): string[] {
  const parts = text
    .split(/(?<=[.!?…])\s+|\n+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return parts.length ? parts : [text.trim()];
}

// Up to this many quick phrases get a Ctrl+F<n> global hotkey (F1..F12).
const PHRASE_HOTKEY_COUNT = 12;

function App() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);
  const [devices, setDevices] = useState<OutputDevice[]>([]);
  const [text, setText] = useState("");
  const [status, setStatus] = useState("starting…");
  const [vanishWarn, setVanishWarn] = useState("");
  const [hotkeyError, setHotkeyError] = useState("");
  const [permissionOk, setPermissionOk] = useState<boolean | null>(null);
  const [speaking, setSpeaking] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Sticky fallback: once the cloud provider errors, we latch onto Piper for the
  // rest of the session and show this banner until the user retries the cloud.
  const [cloudDown, setCloudDown] = useState("");
  const latchedRef = useRef(false);
  // Whether an OpenAI key is saved in the keychain (reflected in Settings UI).
  const [hasOpenAiKey, setHasOpenAiKey] = useState(false);
  const [keyInput, setKeyInput] = useState("");

  // Refs mirror state for use inside event-listener / hotkey closures that would
  // otherwise capture a stale snapshot.
  const settingsRef = useRef<Settings>(DEFAULTS);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const cacheRef = useRef(new BlobCache());
  const currentAudios = useRef<HTMLAudioElement[]>([]);
  // Generation token: bumped on every stop so a superseded playback can detect it.
  const genRef = useRef(0);
  // Token to cancel an in-flight prewarm loop (bumped when rate/voice changes) so
  // it can't keep spawning Piper for audio that's already stale.
  const prewarmGen = useRef(0);

  // ---- settings helpers -------------------------------------------------

  function applySettings(next: Settings) {
    settingsRef.current = next;
    setSettings(next);
    void saveSettings(next);
  }

  function patch(p: Partial<Settings>) {
    applySettings({ ...settingsRef.current, ...p });
  }

  // ---- playback ---------------------------------------------------------

  function stopCurrent() {
    genRef.current++;
    currentAudios.current.forEach((a) => a.pause());
    currentAudios.current = [];
    setSpeaking(false);
  }

  async function playBlob(blob: Blob) {
    currentAudios.current = [];
    const s = settingsRef.current;
    const track = (a: HTMLAudioElement) => currentAudios.current.push(a);

    const primary = playToDevice(blob, s.outputDeviceId, {
      volume: s.volume,
      onStarted: track,
    });
    if (s.monitorEnabled && s.monitorDeviceId !== s.outputDeviceId) {
      playToDevice(blob, s.monitorDeviceId, {
        volume: s.volume,
        onStarted: track,
      }).catch((e) => console.warn("monitor playback failed:", e));
    }
    await primary;
  }

  /** Synthesize one sentence via Piper (or hit the cache). Returns the WAV blob. */
  async function getAudio(t: string): Promise<Blob> {
    const s = settingsRef.current;
    const key = cacheKey(piperVariant(s), t);
    const cached = cacheRef.current.get(key);
    if (cached) return cached;
    const buf = await invoke<ArrayBuffer>("speak", {
      text: t,
      modelPath: s.piper.voiceModelPath || null,
      lengthScale: s.piper.lengthScale,
    });
    const blob = new Blob([buf], { type: "audio/wav" });
    cacheRef.current.set(key, blob);
    return blob;
  }

  /**
   * Speak text. Barge-in: always interrupts whatever is currently playing.
   * Dispatches to the cloud (OpenAI streaming) or Piper depending on the chosen
   * provider and whether we've latched onto Piper after a cloud failure.
   */
  async function speakText(t: string) {
    const clean = t.trim();
    if (!clean) return;
    stopCurrent(); // barge-in
    const gen = genRef.current;
    setSpeaking(true);
    setStatus("falando…");

    const sentences = splitSentences(clean);
    const useCloud =
      settingsRef.current.provider === "openai" && !latchedRef.current;
    try {
      if (useCloud) {
        await speakCloud(sentences, gen);
      } else {
        await speakPiper(sentences, gen);
      }
    } catch (e) {
      if (gen === genRef.current) setStatus(`❌ ${msg(e)}`);
    } finally {
      if (gen === genRef.current) setSpeaking(false);
    }
  }

  /** Piper path: sentences are pipelined — each plays while the next synthesizes. */
  async function speakPiper(sentences: string[], gen: number) {
    let next: Promise<Blob> | null = getAudio(sentences[0]);
    try {
      for (let i = 0; i < sentences.length; i++) {
        const blob = await next!;
        if (gen !== genRef.current) return; // superseded
        next = i + 1 < sentences.length ? getAudio(sentences[i + 1]) : null;
        await playBlob(blob);
        if (gen !== genRef.current) return;
      }
      if (gen === genRef.current) setStatus("");
    } finally {
      // A prefetch we never awaited (barge-in / error) must not surface as an
      // unhandled rejection.
      if (next) next.catch(() => {});
    }
  }

  /**
   * Cloud path: stream each sentence as MP3 via OpenAI. A cached clip replays
   * through the normal Blob path. On a latchable error we flip to Piper for the
   * rest of this utterance and stay on Piper for the session (sticky fallback).
   */
  async function speakCloud(sentences: string[], gen: number) {
    for (let i = 0; i < sentences.length; i++) {
      if (gen !== genRef.current) return;
      const sent = sentences[i];
      const key = cacheKey(openaiVariant(settingsRef.current), sent);

      const cached = cacheRef.current.get(key);
      if (cached) {
        await playBlob(cached);
        if (gen !== genRef.current) return;
        continue;
      }

      try {
        const blob = await streamCloudSentence(sent, gen);
        if (gen !== genRef.current) return;
        if (blob && blob.size > 0) cacheRef.current.set(key, blob);
      } catch (err) {
        const e = err as TtsError;
        if (isLatchable(e.kind)) {
          latchedRef.current = true;
          setCloudDown(
            `Cloud TTS unavailable (${e.kind}) — using Piper. ${e.message ?? ""}`
          );
        }
        // Cover this sentence and the rest with Piper so the call isn't left silent.
        await speakPiper(sentences.slice(i), gen);
        return;
      }
    }
    if (gen === genRef.current) setStatus("");
  }

  /**
   * Stream one sentence from OpenAI into a MediaSource player, fanning audio to
   * the call output (+ monitor). Resolves with the assembled MP3 blob (for the
   * cache) once playback ends. Rejects with the structured TtsError on failure.
   */
  async function streamCloudSentence(
    sent: string,
    gen: number
  ): Promise<Blob | null> {
    const s = settingsRef.current;
    const sinks = [s.outputDeviceId];
    if (s.monitorEnabled && s.monitorDeviceId !== s.outputDeviceId) {
      sinks.push(s.monitorDeviceId);
    }

    currentAudios.current = [];
    const player = await MseStreamPlayer.create(sinks, s.volume, (a) =>
      currentAudios.current.push(a)
    );

    const channel = new Channel<ArrayBuffer | string>();
    channel.onmessage = (m) => {
      if (typeof m === "string") {
        player.finish(); // ordered "end" sentinel: all audio has been sent
      } else {
        player.feed(new Uint8Array(m));
      }
    };

    try {
      await invoke("speak_openai", {
        onChunk: channel,
        text: sent,
        voice: s.openai.voice,
        instructions: s.openai.instructions,
        model: s.openai.model,
      });
    } catch (e) {
      player.abort();
      throw e; // structured TtsError -> caller decides on fallback/latch
    }

    // Playback ends after the ordered sentinel triggered finish() + endOfStream().
    await player.waitEnded();
    if (gen !== genRef.current) return null;
    return player.blob();
  }

  /** Pre-render the quick phrases so they play with zero latency. Fire-and-forget.
   *  Piper only — we don't auto-spend OpenAI tokens on launch; cloud phrases warm
   *  lazily on first use and then persist in the Rust disk cache across restarts. */
  async function prewarm() {
    if (settingsRef.current.provider !== "piper") return;
    const gen = ++prewarmGen.current;
    for (const p of settingsRef.current.quickPhrases) {
      if (gen !== prewarmGen.current) return; // superseded by a newer rate/voice
      try {
        await getAudio(p);
      } catch {
        /* ignore — surfaced when actually spoken */
      }
    }
  }

  // ---- devices ----------------------------------------------------------

  function resolveOutput(
    outs: OutputDevice[],
    label: string,
    id: string
  ): OutputDevice | undefined {
    return (
      (label ? outs.find((d) => d.label === label) : undefined) ??
      (id ? outs.find((d) => d.deviceId === id) : undefined)
    );
  }

  async function refreshDevices() {
    const unlock = await unlockDeviceLabels();
    setPermissionOk(unlock.granted);
    const outs = await listOutputDevices();
    setDevices(outs);

    const s = settingsRef.current;
    if (s.outputLabel || s.outputDeviceId) {
      const dev = resolveOutput(outs, s.outputLabel, s.outputDeviceId);
      if (dev) {
        if (dev.deviceId !== s.outputDeviceId || dev.label !== s.outputLabel) {
          patch({ outputDeviceId: dev.deviceId, outputLabel: dev.label });
        }
        setVanishWarn("");
      } else {
        setVanishWarn(
          `⚠️ Saved output “${s.outputLabel || s.outputDeviceId}” is gone — your ` +
            `voice will NOT reach the call until you pick a device below.`
        );
      }
    } else if (outs.length) {
      patch({ outputDeviceId: outs[0].deviceId, outputLabel: outs[0].label });
    }

    setStatus(
      unlock.granted
        ? `ready — ${outs.length} output(s), setSinkId: ${supportsSetSinkId()}`
        : `⚠️ mic permission denied (${unlock.error ?? "?"}) — device labels hidden`
    );
  }

  function pickOutput(deviceId: string) {
    const dev = devices.find((d) => d.deviceId === deviceId);
    patch({ outputDeviceId: deviceId, outputLabel: dev?.label ?? "" });
    setVanishWarn("");
  }

  // ---- hotkey / window --------------------------------------------------

  async function focusApp() {
    const w = getCurrentWindow();
    await w.show();
    await w.unminimize();
    await w.setFocus();
    inputRef.current?.focus();
  }

  async function applyHotkey(accel: string, prev?: string) {
    try {
      if (prev && prev !== accel && (await isRegistered(prev))) {
        await unregister(prev);
      }
      if (await isRegistered(accel)) await unregister(accel);
      await register(accel, (event) => {
        if (event.state === "Pressed") void focusApp();
      });
      setHotkeyError("");
    } catch (e) {
      setHotkeyError(`hotkey “${accel}” failed: ${msg(e)}`);
    }
  }

  // Bind Ctrl+F1..F12 to quick phrases by INDEX. Registered once at startup; the
  // handler reads the current phrase from the ref at fire time, so editing
  // phrases never needs re-registration. Fires even when the app isn't focused —
  // speak a canned line mid-call without alt-tabbing.
  async function registerPhraseHotkeys() {
    for (let i = 0; i < PHRASE_HOTKEY_COUNT; i++) {
      const accel = `CommandOrControl+F${i + 1}`;
      try {
        if (await isRegistered(accel)) await unregister(accel);
        await register(accel, (event) => {
          if (event.state !== "Pressed") return;
          const p = settingsRef.current.quickPhrases[i];
          if (p && p.trim()) void speakText(p);
        });
      } catch (e) {
        console.warn(`phrase hotkey ${accel} failed:`, e);
      }
    }
  }

  // Open a native file picker for the voice model — avoids the manual-path
  // quoting pitfalls (e.g. Windows "Copy as path" wrapping the path in quotes).
  async function browseVoice() {
    try {
      const selected = await open({
        multiple: false,
        filters: [{ name: "Piper voice", extensions: ["onnx"] }],
      });
      if (typeof selected === "string") {
        patchPiper({ voiceModelPath: selected });
      }
    } catch (e) {
      setStatus(`❌ ${msg(e)}`);
    }
  }

  // Play a short tone to the chosen call output so routing into the virtual
  // cable can be verified before relying on it in a live call.
  async function testOutput() {
    try {
      const s = settingsRef.current;
      await playToDevice(makeToneWavBlob(660, 0.5), s.outputDeviceId, {
        volume: s.volume,
      });
      setStatus("🔊 test tone sent to call output");
    } catch (e) {
      setStatus(`❌ test failed: ${msg(e)}`);
    }
  }

  // ---- lifecycle --------------------------------------------------------

  useEffect(() => {
    let disposed = false;
    (async () => {
      const loaded = await loadSettings();
      // Reflect the OS-level autostart truth (does the Scheduled Task exist?)
      // rather than our stored guess.
      try {
        loaded.autostart = await invoke<boolean>("autostart_is_enabled");
      } catch {
        /* command unavailable — keep stored value */
      }
      if (disposed) return;
      settingsRef.current = loaded;
      setSettings(loaded);

      try {
        await getCurrentWindow().setAlwaysOnTop(loaded.keepOnTop);
      } catch (e) {
        console.warn("keep-on-top:", e);
      }
      try {
        setHasOpenAiKey(
          await invoke<boolean>("has_api_key", { provider: "openai" })
        );
      } catch {
        /* command unavailable — assume no key */
      }
      await applyHotkey(loaded.hotkey);
      await registerPhraseHotkeys();
      await refreshDevices();
      void prewarm();
    })();

    const onChange = () => refreshDevices();
    navigator.mediaDevices.addEventListener?.("devicechange", onChange);

    // Esc anywhere = panic stop (halt cable + monitor).
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        stopCurrent();
        setStatus("■ parado");
      }
    };
    window.addEventListener("keydown", onKey);

    return () => {
      disposed = true;
      navigator.mediaDevices.removeEventListener?.("devicechange", onChange);
      window.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ---- UI event handlers ------------------------------------------------

  function onInputKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      const t = text;
      setText("");
      void speakText(t);
      inputRef.current?.focus();
    }
    // Shift+Enter falls through → newline. Esc handled by the window listener.
  }

  function changeVoiceOrRate(p: Partial<Settings>) {
    // Just drop the stale audio; don't re-synthesize. Quick phrases are rendered
    // lazily on click (and cached), so sweeping the rate slider costs nothing —
    // we'd only be warming phrases at a rate you'll probably never click anyway.
    cacheRef.current.clear();
    prewarmGen.current++; // cancel any prewarm still in flight (e.g. startup warm)
    patch(p);
  }

  function patchPiper(p: Partial<PiperConfig>) {
    changeVoiceOrRate({ piper: { ...settingsRef.current.piper, ...p } });
  }
  function patchOpenAi(p: Partial<OpenAiConfig>) {
    changeVoiceOrRate({ openai: { ...settingsRef.current.openai, ...p } });
  }

  function changeProvider(provider: Provider) {
    latchedRef.current = false; // a deliberate switch re-arms the cloud
    setCloudDown("");
    changeVoiceOrRate({ provider });
    if (provider === "piper") void prewarm();
  }

  // Re-arm the cloud after a sticky fallback (e.g. you fixed billing / network).
  function retryCloud() {
    latchedRef.current = false;
    setCloudDown("");
    setStatus("cloud re-armed");
  }

  async function saveOpenAiKey() {
    try {
      await invoke("set_api_key", { provider: "openai", key: keyInput });
      const has = await invoke<boolean>("has_api_key", { provider: "openai" });
      setHasOpenAiKey(has);
      setKeyInput("");
      latchedRef.current = false; // a fresh key deserves another cloud attempt
      setCloudDown("");
      setStatus(has ? "✅ OpenAI key saved" : "key cleared");
    } catch (e) {
      setStatus(`❌ key: ${msg(e)}`);
    }
  }

  async function clearOpenAiKey() {
    try {
      await invoke("delete_api_key", { provider: "openai" });
      setHasOpenAiKey(false);
      setStatus("OpenAI key removed");
    } catch (e) {
      setStatus(`❌ key: ${msg(e)}`);
    }
  }

  function editPhrase(i: number, value: string) {
    const next = settings.quickPhrases.slice();
    next[i] = value;
    patch({ quickPhrases: next });
  }
  function removePhrase(i: number) {
    patch({ quickPhrases: settings.quickPhrases.filter((_, j) => j !== i) });
  }
  function addPhrase() {
    patch({ quickPhrases: [...settings.quickPhrases, ""] });
  }

  async function toggleAutostart(on: boolean) {
    try {
      await invoke("autostart_set", { enabled: on });
      patch({ autostart: on });
      setStatus(on ? "✅ inicia com o Windows" : "autostart desligado");
    } catch (e) {
      setStatus(`❌ autostart: ${msg(e)}`);
    }
  }

  async function toggleKeepOnTop(on: boolean) {
    patch({ keepOnTop: on });
    try {
      await getCurrentWindow().setAlwaysOnTop(on);
    } catch (e) {
      console.warn("keep-on-top:", e);
    }
  }

  // ---- render -----------------------------------------------------------

  return (
    <main className="app">
      <header className="head">
        <h1>minhavoz</h1>
        <div className="head-right">
          <span className={speaking ? "dot live" : "dot"} title="speaking">
            ●
          </span>
          <button
            className="icon"
            onClick={() => setShowSettings((v) => !v)}
            title="Settings"
          >
            ⚙
          </button>
        </div>
      </header>

      {vanishWarn && <p className="warn">{vanishWarn}</p>}
      {hotkeyError && <p className="warn">{hotkeyError}</p>}
      {cloudDown && (
        <p className="warn">
          {cloudDown}{" "}
          <button type="button" className="link" onClick={retryCloud}>
            Retry cloud
          </button>
        </p>
      )}

      <textarea
        ref={inputRef}
        className="input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onInputKeyDown}
        placeholder="Type, press Enter to speak. Shift+Enter = newline. Esc = stop."
        rows={3}
        autoFocus
      />

      <div className="row controls">
        <button
          className="primary"
          onClick={() => {
            const t = text;
            setText("");
            void speakText(t);
            inputRef.current?.focus();
          }}
        >
          Speak ⏎
        </button>
        <button onClick={stopCurrent} disabled={!speaking}>
          ■ Stop (Esc)
        </button>
      </div>

      {settings.provider === "piper" && (
      <div className="rate-row">
        <span className="rate-label">Rate</span>
        <div className="rate-control">
          <div className="rate-rail">
            <div
              className="rate-fill"
              style={{ width: `${ratePct(settings.piper.lengthScale)}%` }}
            />
          </div>
          <input
            className="rate-slider"
            type="range"
            min={LOG_MIN}
            max={LOG_MAX}
            step={0.001}
            value={toLog(settings.piper.lengthScale)}
            onChange={(e) =>
              patchPiper({
                lengthScale: snapRate(fromLog(Number(e.target.value))),
              })
            }
          />
          <div className="rate-guides">
            {RATE_GUIDES.map(({ v, label }) => {
              const active = Math.abs(settings.piper.lengthScale - v) < 0.001;
              return (
                <button
                  key={v}
                  type="button"
                  className={
                    "rate-guide" +
                    (label ? "" : " tick-only") +
                    (active ? " active" : "")
                  }
                  style={{ left: `${ratePct(v)}%` }}
                  title={`${v.toFixed(2)}× — ${
                    v < 1 ? "faster" : v > 1 ? "slower" : "normal"
                  }`}
                  onClick={() => patchPiper({ lengthScale: v })}
                >
                  <span className="tick" />
                  {label ? <span>{v === 1 ? "1×" : v}</span> : null}
                </button>
              );
            })}
          </div>
        </div>
        <span className="rate-val">{settings.piper.lengthScale.toFixed(2)}×</span>
      </div>
      )}

      <div className="phrases">
        {settings.quickPhrases.map((p, i) =>
          p.trim() ? (
            <button
              key={i}
              className="chip"
              onClick={() => {
                void speakText(p);
                inputRef.current?.focus();
              }}
              title={
                i < PHRASE_HOTKEY_COUNT ? `${p}\n(Ctrl+F${i + 1})` : p
              }
            >
              {i < PHRASE_HOTKEY_COUNT && (
                <span className="chip-key">F{i + 1}</span>
              )}
              {p.length > 28 ? p.slice(0, 27) + "…" : p}
            </button>
          ) : null
        )}
      </div>

      <p className={permissionOk === false ? "warn" : "status"}>{status}</p>

      {showSettings && (
        <div className="modal-backdrop" onClick={() => setShowSettings(false)}>
          <section
            className="settings modal"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="modal-head">
              <h2>Settings</h2>
              <button
                className="icon"
                onClick={() => setShowSettings(false)}
                title="Close"
              >
                ✕
              </button>
            </div>

          <label className="field">
            <span>Output (→ call)</span>
            <div className="row">
              <select
                value={settings.outputDeviceId}
                onChange={(e) => pickOutput(e.target.value)}
              >
                {devices.length === 0 && <option value="">(no outputs)</option>}
                {devices.map((d) => (
                  <option key={d.deviceId} value={d.deviceId}>
                    {d.label}
                  </option>
                ))}
              </select>
              <button
                type="button"
                onClick={() => void testOutput()}
                title="Play a test tone to the selected call output"
              >
                🔊 Test
              </button>
            </div>
          </label>

          <label className="field">
            <span>
              <input
                type="checkbox"
                checked={settings.monitorEnabled}
                onChange={(e) => patch({ monitorEnabled: e.target.checked })}
              />{" "}
              Monitor (→ you)
            </span>
            <select
              value={settings.monitorDeviceId}
              onChange={(e) => patch({ monitorDeviceId: e.target.value })}
              disabled={!settings.monitorEnabled}
            >
              <option value="default">(system default)</option>
              {devices.map((d) => (
                <option key={d.deviceId} value={d.deviceId}>
                  {d.label}
                </option>
              ))}
            </select>
          </label>

          <label className="field">
            <span>Volume</span>
            <input
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={settings.volume}
              onChange={(e) => patch({ volume: Number(e.target.value) })}
            />
          </label>

          <label className="field">
            <span>TTS provider</span>
            <select
              value={settings.provider}
              onChange={(e) => changeProvider(e.target.value as Provider)}
            >
              <option value="piper">Piper (local, free, offline)</option>
              <option value="openai">OpenAI (cloud, gpt-4o-mini-tts)</option>
            </select>
          </label>

          {settings.provider === "piper" && (
            <label className="field">
              <span>Voice .onnx path</span>
              <div className="row">
                <input
                  type="text"
                  placeholder="(bundled cadu pt-BR)"
                  value={settings.piper.voiceModelPath}
                  onChange={(e) => patchPiper({ voiceModelPath: e.target.value })}
                />
                <button type="button" onClick={() => void browseVoice()}>
                  Browse…
                </button>
              </div>
            </label>
          )}

          {settings.provider === "openai" && (
            <>
              <label className="field">
                <span>OpenAI API key {hasOpenAiKey ? "✓ saved" : "(not set)"}</span>
                <div className="row">
                  <input
                    type="password"
                    placeholder={hasOpenAiKey ? "•••••• (saved)" : "sk-…"}
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                  />
                  <button
                    type="button"
                    onClick={() => void saveOpenAiKey()}
                    disabled={!keyInput.trim()}
                  >
                    Save
                  </button>
                  {hasOpenAiKey && (
                    <button type="button" onClick={() => void clearOpenAiKey()}>
                      Remove
                    </button>
                  )}
                </div>
              </label>

              <label className="field">
                <span>Voice</span>
                <select
                  value={settings.openai.voice}
                  onChange={(e) => patchOpenAi({ voice: e.target.value })}
                >
                  {OPENAI_VOICES.map((v) => (
                    <option key={v} value={v}>
                      {v}
                    </option>
                  ))}
                </select>
              </label>

              <label className="field">
                <span>Voice instructions (tone / accent)</span>
                <textarea
                  rows={2}
                  placeholder="e.g. Fale em português do Brasil, tom calmo e natural."
                  value={settings.openai.instructions}
                  onChange={(e) => patchOpenAi({ instructions: e.target.value })}
                />
              </label>
            </>
          )}

          <label className="field">
            <span>Global hotkey</span>
            <input
              type="text"
              value={settings.hotkey}
              onChange={(e) => patch({ hotkey: e.target.value })}
              onBlur={(e) => void applyHotkey(e.target.value, settings.hotkey)}
            />
          </label>

          <label className="field inline">
            <input
              type="checkbox"
              checked={settings.keepOnTop}
              onChange={(e) => void toggleKeepOnTop(e.target.checked)}
            />
            <span>Keep window on top</span>
          </label>

          <label className="field inline">
            <input
              type="checkbox"
              checked={settings.autostart}
              onChange={(e) => void toggleAutostart(e.target.checked)}
            />
            <span>Start on Windows login</span>
          </label>

          <div className="phrase-editor">
            <span>Quick phrases</span>
            {settings.quickPhrases.map((p, i) => (
              <div className="row" key={i}>
                <input
                  type="text"
                  value={p}
                  onChange={(e) => editPhrase(i, e.target.value)}
                />
                <button className="icon" onClick={() => removePhrase(i)}>
                  ✕
                </button>
              </div>
            ))}
            <button onClick={addPhrase}>+ phrase</button>
          </div>

          <button onClick={refreshDevices}>↻ Refresh devices</button>
          </section>
        </div>
      )}
    </main>
  );
}

export default App;
