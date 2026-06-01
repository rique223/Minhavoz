// Persisted settings via tauri-plugin-store (settings.json in the app config dir).
// The output device is saved BY LABEL (deviceId is only a hint) because Windows
// reshuffles deviceIds across reboots / device changes — see resolveOutput in App.
//
// Provider-specific config is nested under `piper` / `openai`. The OpenAI API key
// is NOT stored here — it lives in the OS keychain (see secrets.rs).

import { load, type Store } from "@tauri-apps/plugin-store";

export type Provider = "piper" | "openai";

export type PiperConfig = {
  /** Empty = use the bundled default cadu voice. Otherwise an absolute .onnx path. */
  voiceModelPath: string;
  /** Piper --length_scale: 1.0 normal, >1 slower, <1 faster. */
  lengthScale: number;
};

export type OpenAiConfig = {
  /** gpt-4o-mini-tts voice id, e.g. "alloy", "nova", "coral". */
  voice: string;
  /** Free-text tone/accent steering for gpt-4o-mini-tts. */
  instructions: string;
  /** Model id; gpt-4o-mini-tts is the cheap, streamable default. */
  model: string;
};

export type Settings = {
  /** Friendly label of the chosen output (e.g. "CABLE Input (VB-Audio Virtual Cable)"). */
  outputLabel: string;
  /** Last-known deviceId for that label — a hint, re-resolved on every enumeration. */
  outputDeviceId: string;
  monitorEnabled: boolean;
  monitorDeviceId: string;
  /** Playback volume 0..1 (HTMLAudioElement.volume). */
  volume: number;
  quickPhrases: string[];
  /** Global hotkey accelerator, e.g. "CommandOrControl+Shift+Space". */
  hotkey: string;
  keepOnTop: boolean;
  autostart: boolean;
  /** Which engine speaks. OpenAI streams MP3; Piper is the local fallback. */
  provider: Provider;
  piper: PiperConfig;
  openai: OpenAiConfig;
};

export const DEFAULT_PHRASES = [
  "Só um segundo, digitando…",
  "Sim",
  "Não",
  "Não posso falar, me recuperando de uma cirurgia — digitando",
  "Me dá um momento",
];

export const OPENAI_VOICES = [
  "alloy",
  "ash",
  "ballad",
  "coral",
  "echo",
  "fable",
  "nova",
  "onyx",
  "sage",
  "shimmer",
];

export const DEFAULTS: Settings = {
  outputLabel: "",
  outputDeviceId: "",
  monitorEnabled: true,
  monitorDeviceId: "default",
  volume: 1.0,
  quickPhrases: DEFAULT_PHRASES,
  hotkey: "CommandOrControl+Shift+Space",
  keepOnTop: true,
  autostart: false,
  provider: "piper",
  piper: { voiceModelPath: "", lengthScale: 1.0 },
  openai: { voice: "alloy", instructions: "", model: "gpt-4o-mini-tts" },
};

let storePromise: Promise<Store> | null = null;
function getStore(): Promise<Store> {
  if (!storePromise) storePromise = load("settings.json");
  return storePromise;
}

// Merge a saved blob over defaults, lifting the legacy flat Piper fields
// (voiceModelPath / lengthScale) into the nested `piper` object for old stores.
function migrate(saved: Record<string, unknown>): Settings {
  const piper: PiperConfig = {
    ...DEFAULTS.piper,
    ...((saved.piper as Partial<PiperConfig>) ?? {}),
  };
  if (saved.piper === undefined) {
    if (typeof saved.voiceModelPath === "string") piper.voiceModelPath = saved.voiceModelPath;
    if (typeof saved.lengthScale === "number") piper.lengthScale = saved.lengthScale;
  }
  const openai: OpenAiConfig = {
    ...DEFAULTS.openai,
    ...((saved.openai as Partial<OpenAiConfig>) ?? {}),
  };

  const merged: Record<string, unknown> = {
    ...DEFAULTS,
    ...saved,
    provider: (saved.provider as Provider) ?? DEFAULTS.provider,
    piper,
    openai,
  };
  // Drop legacy flat keys so they don't linger in the persisted object.
  delete merged.voiceModelPath;
  delete merged.lengthScale;
  return merged as Settings;
}

export async function loadSettings(): Promise<Settings> {
  const store = await getStore();
  const saved = (await store.get<Record<string, unknown>>("settings")) ?? {};
  return migrate(saved);
}

export async function saveSettings(s: Settings): Promise<void> {
  const store = await getStore();
  await store.set("settings", s);
  await store.save();
}
