/**
 * The synthetic workspace's live stream: a reconnecting EventSource over /api/synth/stream.
 *
 *   • opened WITH credentials (the synth session cookie rides on it), never a token in the URL;
 *   • a transient drop reconnects with capped exponential backoff, reset on every open;
 *   • after an error ONE bounded probe asks whether the synth session is still alive; a dead
 *     session stops the stream (no reconnect loop against a 401) and reports it;
 *   • a `session_ended` frame (the server re-checks the session while the stream is open) is
 *     handled the same way.
 *
 * Pure enough to test: the EventSource factory and the timers are injectable.
 */

export interface SynthEventSourceLike {
  addEventListener(type: string, listener: (ev: { data: string }) => void): void;
  onopen: (() => void) | null;
  onerror: (() => void) | null;
  close(): void;
}

export interface SynthStreamOptions {
  url: string;
  events: string[];
  onEvent: (type: string, data: string) => void;
  onOpen?: () => void;
  onDisconnect?: () => void;
  /** The synth session is gone: stop and let the page show its gate. */
  onSessionEnded: () => void;
  /** Resolves true when the synth session is dead. A probe that fails counts as NOT dead. */
  probeSessionEnded: () => Promise<boolean>;
  probeTimeoutMs?: number;
  create?: (url: string) => SynthEventSourceLike;
  baseDelayMs?: number;
  maxDelayMs?: number;
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

function defaultCreate(url: string): SynthEventSourceLike {
  return new EventSource(url, { withCredentials: true }) as unknown as SynthEventSourceLike;
}

export class SynthStream {
  private es: SynthEventSourceLike | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = true;
  private readonly o: Required<Omit<SynthStreamOptions, "onOpen" | "onDisconnect">> &
    Pick<SynthStreamOptions, "onOpen" | "onDisconnect">;

  constructor(options: SynthStreamOptions) {
    this.o = {
      probeTimeoutMs: 10_000,
      create: defaultCreate,
      baseDelayMs: 1000,
      maxDelayMs: 30_000,
      setTimeoutFn: (fn, ms) => window.setTimeout(fn, ms),
      clearTimeoutFn: (h) => window.clearTimeout(h),
      ...options,
    };
  }

  /** Backoff for the n-th reconnect (0-based), capped. */
  backoffFor(n: number): number {
    return Math.min(this.o.maxDelayMs, this.o.baseDelayMs * 2 ** Math.min(n, 16));
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer !== null) this.o.clearTimeoutFn(this.timer);
    this.timer = null;
    this.es?.close();
    this.es = null;
  }

  private open(): void {
    if (this.stopped) return;
    const es = this.o.create(this.o.url);
    this.es = es;
    es.onopen = () => {
      if (this.stopped || this.es !== es) return;
      this.attempt = 0;
      this.o.onOpen?.();
    };
    for (const type of this.o.events) {
      es.addEventListener(type, (ev) => {
        // A frame from a replaced or stopped source is stale: never act on it.
        if (this.stopped || this.es !== es) return;
        if (type === "session_ended") {
          this.stop();
          this.o.onSessionEnded();
          return;
        }
        this.o.onEvent(type, ev.data);
      });
    }
    es.onerror = () => {
      if (this.stopped || this.es !== es) return;
      es.close();
      this.es = null;
      this.o.onDisconnect?.();
      void this.afterError();
    };
  }

  private async afterError(): Promise<void> {
    const dead = await Promise.race([
      this.o.probeSessionEnded().catch(() => false),
      new Promise<boolean>((resolve) => this.o.setTimeoutFn(() => resolve(false), this.o.probeTimeoutMs)),
    ]);
    if (this.stopped) return;
    if (dead) {
      this.stop();
      this.o.onSessionEnded();
      return;
    }
    const delay = this.backoffFor(this.attempt++);
    this.timer = this.o.setTimeoutFn(() => {
      this.timer = null;
      this.open();
    }, delay);
  }
}
