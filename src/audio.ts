// Audio routing helpers. Everything device-related lives here so the spike UI
// stays thin. The whole architecture rests on two Chromium APIs working inside
// WebView2: getUserMedia (to unlock device labels) and HTMLAudioElement.setSinkId
// (to route playback to a chosen output, e.g. "CABLE Input").

export type OutputDevice = { deviceId: string; label: string };

export type LabelUnlock = { granted: boolean; error?: string };

/**
 * enumerateDevices() returns blank labels until audio permission is granted.
 * Call getUserMedia once to unlock labels, then immediately stop the tracks.
 */
export async function unlockDeviceLabels(): Promise<LabelUnlock> {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach((t) => t.stop());
    return { granted: true };
  } catch (e) {
    return { granted: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function listOutputDevices(): Promise<OutputDevice[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "audiooutput")
    .map((d, i) => ({
      deviceId: d.deviceId,
      label: d.label || `Output ${i + 1} (label hidden — grant mic permission)`,
    }));
}

export function supportsSetSinkId(): boolean {
  return "setSinkId" in HTMLAudioElement.prototype;
}

/**
 * Play a Blob to a specific output device. Resolves when playback ends.
 * Returns the Audio element so callers can keep a handle for panic-stop.
 */
export async function playToDevice(
  blob: Blob,
  sinkId: string,
  opts: { volume?: number; onStarted?: (a: HTMLAudioElement) => void } = {}
): Promise<void> {
  const url = URL.createObjectURL(blob);
  const audio = new Audio(url);
  audio.volume = opts.volume ?? 1;

  const cleanup = () => URL.revokeObjectURL(url);

  try {
    if (sinkId && sinkId !== "default" && "setSinkId" in audio) {
      await audio.setSinkId(sinkId);
    }
  } catch (e) {
    cleanup();
    throw new Error(
      `setSinkId failed (device may be disconnected): ${
        e instanceof Error ? e.message : String(e)
      }`
    );
  }

  await new Promise<void>((resolve, reject) => {
    audio.onended = () => {
      cleanup();
      resolve();
    };
    // pause() is how we barge-in / panic-stop. Treat it as a clean end so the
    // caller's await doesn't hang forever on a superseded playback.
    audio.onpause = () => {
      cleanup();
      resolve();
    };
    audio.onerror = () => {
      cleanup();
      reject(new Error("audio playback error (device disconnected?)"));
    };
    opts.onStarted?.(audio);
    audio.play().catch((e) => {
      cleanup();
      reject(e);
    });
  });
}

// ---- streaming playback (MSE) --------------------------------------------
//
// For the OpenAI cloud path we receive MP3 in chunks and want first-audio ASAP,
// so we feed a MediaSource('audio/mpeg') instead of waiting for a whole Blob.
// We fan the same chunks out to one element per sink (call output + optional
// monitor), each routed with setSinkId. Proven viable in WebView2 by the spike.

export function supportsMseMp3(): boolean {
  return (
    typeof MediaSource !== "undefined" && MediaSource.isTypeSupported("audio/mpeg")
  );
}

type MseTarget = {
  audio: HTMLAudioElement;
  ms: MediaSource;
  sb: SourceBuffer;
  queue: Uint8Array[];
  appended: boolean;
  ended: boolean;
};

/**
 * Plays a chunked MP3 stream to one or more output devices via MediaSource.
 * Lifecycle: create() -> feed(chunk)* -> finish() -> waitEnded(); abort() to
 * barge-in. blob() returns the assembled MP3 for the in-memory cache.
 */
export class MseStreamPlayer {
  private targets: MseTarget[] = [];
  private chunks: Uint8Array[] = [];
  private started = false;
  private aborted = false;
  private resolveEnded!: () => void;
  private endedPromise: Promise<void>;

  private constructor(
    private volume: number,
    private onStarted?: (a: HTMLAudioElement) => void
  ) {
    this.endedPromise = new Promise((res) => (this.resolveEnded = res));
  }

  static async create(
    sinkIds: string[],
    volume: number,
    onStarted?: (a: HTMLAudioElement) => void
  ): Promise<MseStreamPlayer> {
    const p = new MseStreamPlayer(volume, onStarted);
    for (let i = 0; i < sinkIds.length; i++) {
      p.targets.push(await p.makeTarget(sinkIds[i], i === 0));
    }
    return p;
  }

  private async makeTarget(sinkId: string, primary: boolean): Promise<MseTarget> {
    const ms = new MediaSource();
    const audio = new Audio();
    audio.volume = this.volume;
    audio.src = URL.createObjectURL(ms);

    await new Promise<void>((resolve, reject) => {
      ms.addEventListener("sourceopen", () => resolve(), { once: true });
      ms.addEventListener("error", () => reject(new Error("MediaSource error")), {
        once: true,
      });
    });

    const sb = ms.addSourceBuffer("audio/mpeg");
    const t: MseTarget = { audio, ms, sb, queue: [], appended: false, ended: false };
    sb.addEventListener("updateend", () => this.pump(t));

    if (sinkId && sinkId !== "default" && "setSinkId" in audio) {
      try {
        await (audio as HTMLAudioElement).setSinkId(sinkId);
      } catch {
        /* a routing failure surfaces as a play()/playback error below */
      }
    }

    if (primary) {
      // pause() is barge-in; treat ended/pause/error all as "playback over" so the
      // caller's waitEnded() never hangs.
      const done = () => {
        this.cleanup();
        this.resolveEnded();
      };
      audio.onended = done;
      audio.onpause = done;
      audio.onerror = done;
    }
    return t;
  }

  private pump(t: MseTarget) {
    if (this.aborted || t.sb.updating) return;
    if (t.queue.length > 0) {
      const next = t.queue.shift()!;
      try {
        t.sb.appendBuffer(next);
        t.appended = true;
      } catch {
        /* transient (e.g. quota) — retry on the next updateend */
      }
      return;
    }
    if (t.ended && t.appended && t.ms.readyState === "open") {
      try {
        t.ms.endOfStream();
      } catch {
        /* already closed */
      }
    }
  }

  feed(chunk: Uint8Array) {
    if (this.aborted) return;
    this.chunks.push(chunk);
    for (const t of this.targets) {
      t.queue.push(chunk);
      if (!t.sb.updating) this.pump(t);
    }
    if (!this.started) {
      this.started = true;
      for (const t of this.targets) {
        this.onStarted?.(t.audio);
        void t.audio.play().catch(() => {});
      }
    }
  }

  finish() {
    for (const t of this.targets) {
      t.ended = true;
      if (!t.sb.updating) this.pump(t);
    }
    // Nothing was ever fed (e.g. empty response): don't leave the caller hanging.
    if (!this.started) this.resolveEnded();
  }

  abort() {
    this.aborted = true;
    for (const t of this.targets) {
      try {
        t.audio.pause();
      } catch {
        /* ignore */
      }
    }
    this.cleanup();
    this.resolveEnded();
  }

  /** Resolves when the primary output finishes (or is stopped/aborted). */
  waitEnded(): Promise<void> {
    return this.endedPromise;
  }

  /** The assembled MP3 so far, for the in-memory replay cache. */
  blob(): Blob {
    return new Blob(this.chunks as BlobPart[], { type: "audio/mpeg" });
  }

  private cleanup() {
    for (const t of this.targets) {
      try {
        URL.revokeObjectURL(t.audio.src);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Generate a short sine-wave WAV Blob — lets us test setSinkId routing without Piper. */
export function makeToneWavBlob(freq = 440, seconds = 0.4, sampleRate = 44100): Blob {
  const n = Math.floor(seconds * sampleRate);
  const bytesPerSample = 2;
  const buffer = new ArrayBuffer(44 + n * bytesPerSample);
  const view = new DataView(buffer);

  const writeStr = (off: number, s: string) => {
    for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
  };

  writeStr(0, "RIFF");
  view.setUint32(4, 36 + n * bytesPerSample, true);
  writeStr(8, "WAVE");
  writeStr(12, "fmt ");
  view.setUint32(16, 16, true); // PCM chunk size
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 1, true); // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * bytesPerSample, true);
  view.setUint16(32, bytesPerSample, true);
  view.setUint16(34, 16, true); // bits per sample
  writeStr(36, "data");
  view.setUint32(40, n * bytesPerSample, true);

  for (let i = 0; i < n; i++) {
    // gentle fade in/out to avoid clicks
    const env = Math.min(1, i / 1000, (n - i) / 1000);
    const sample = Math.sin((2 * Math.PI * freq * i) / sampleRate) * env * 0.3;
    view.setInt16(44 + i * bytesPerSample, sample * 0x7fff, true);
  }
  return new Blob([buffer], { type: "audio/wav" });
}
