// Synthesis cache. A cache makes repeated text (quick phrases, retries, common
// replies) play instantly. Keyed by a provider-specific "variant" string (voice +
// rate, or model + voice + instructions) plus the text, so switching provider,
// voice, rate, or instructions cleanly misses old entries.

export function cacheKey(variant: string, text: string): string {
  return `${variant}\n${text}`;
}

/** Tiny LRU of synthesized audio blobs (Piper WAV or OpenAI MP3). */
export class BlobCache {
  private map = new Map<string, Blob>();
  constructor(private capacity = 48) {}

  get(key: string): Blob | undefined {
    const v = this.map.get(key);
    if (v) {
      // Bump to most-recently-used.
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: string, blob: Blob): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, blob);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}
