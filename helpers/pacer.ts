/**
 * Spaces out navigations to the same host. A crawler that opens four pages
 * on one site in the same 200 ms is the easiest pattern for a WAF to score;
 * a person never does that. Each host gets a minimum gap between navigation
 * starts (plus random jitter), shared by every concurrent scrape in this
 * process. The wait is capped so a burst queues briefly instead of eating
 * the caller's whole scrape timeout.
 */
export type PacerOptions = {
  minIntervalMs: number;
  jitterMs: number;
  maxWaitMs: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
};

export class HostPacer {
  private readonly nextSlot = new Map<string, number>();
  private readonly opts: Required<PacerOptions>;

  constructor(opts: PacerOptions) {
    this.opts = {
      now: Date.now,
      sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
      random: Math.random,
      ...opts,
    };
  }

  get enabled(): boolean {
    return this.opts.minIntervalMs > 0;
  }

  /** Normalises www. away so example.com and www.example.com share a slot. */
  static key(hostname: string): string {
    return hostname.toLowerCase().replace(/\.$/, '').replace(/^www\./, '');
  }

  /**
   * Reserves the next slot for `hostname` and resolves when it arrives.
   * Returns the milliseconds actually waited.
   */
  async wait(hostname: string): Promise<number> {
    if (!this.enabled) return 0;
    const { minIntervalMs, jitterMs, maxWaitMs, now, sleep, random } =
      this.opts;
    const key = HostPacer.key(hostname);
    const t = now();
    const slot = Math.max(t, this.nextSlot.get(key) ?? 0);
    const waitMs = Math.min(slot - t, maxWaitMs);
    const gap = minIntervalMs + Math.floor(random() * (jitterMs + 1));
    this.nextSlot.set(key, t + waitMs + gap);
    this.prune(t);
    if (waitMs > 0) await sleep(waitMs);
    return waitMs;
  }

  /** Drops slots that are long past, so the map does not grow forever. */
  private prune(t: number) {
    if (this.nextSlot.size < 1000) return;
    for (const [k, v] of this.nextSlot) {
      if (v < t) this.nextSlot.delete(k);
    }
  }
}
