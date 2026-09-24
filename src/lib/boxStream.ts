/**
 * A reconnecting EventSource for the Box stream.
 *
 * WHY THIS EXISTS
 * ---------------
 * A bare `new EventSource(url)` reconnects on its own, but with no ceiling on the browser's
 * retry cadence and, crucially, NO way to stop after an auth failure — it would hammer a
 * 401ing endpoint forever. The opposite is required on a 401: close, notify, and stay closed
 * until the user re-authenticates.
 *
 * THE CONTRACT
 *   • Opens with `withCredentials: true` — the SSE authenticates with the same-origin
 *     HttpOnly session cookie, NOT a token in the query string.
 *   • On a TRANSIENT error it reconnects with exponential backoff CAPPED at a ceiling.
 *   • On a 401 it does NOT reconnect: it closes, calls `onUnauthorized`, and stops. The 401
 *     is detected out-of-band (a real EventSource error event carries no status code), so
 *     the caller supplies `probeUnauthorized` — a cheap authenticated GET that resolves true
 *     when the session is gone. This keeps the "is this a network blip or a dead session?"
 *     decision in one place.
 *
 * The class is intentionally free of React so its reconnect/backoff logic is unit-testable
 * under node:test with a fake EventSource.
 */

export interface EventSourceLike {
  addEventListener(type: string, listener: (ev: MessageEvent) => void): void;
  close(): void;
  onerror: ((ev: unknown) => void) | null;
  onopen: ((ev: unknown) => void) | null;
}

export interface ReconnectingSseOptions {
  url: string;
  /** Named SSE events to forward, e.g. ["snapshot", "entry", "exit"]. */
  events: string[];
  onEvent: (type: string, data: string) => void;
  /** Called once when the stream connects (or reconnects). */
  onOpen?: () => void;
  /** Called on every transient disconnect, before a reconnect is scheduled. */
  onDisconnect?: () => void;
  /**
   * Called exactly once when the stream is torn down because the session is gone. After
   * this fires the SSE will NOT reconnect.
   */
  onUnauthorized: () => void;
  /**
   * Decide whether an error is due to an expired session. Resolves true ⇒ treat as 401:
   * stop and call `onUnauthorized`. Resolves false ⇒ transient: reconnect with backoff.
   */
  probeUnauthorized: () => Promise<boolean>;
  /**
   * Deadline for `probeUnauthorized`, in ms. Default 10000. `0` disables it.
   *
   * WHY THIS IS NEEDED. `handleError` sets a `probing` latch and only clears it when the probe settles.
   * If the probe never settles — a TCP black hole, a hung proxy, a captive portal — neither `.then` nor
   * `.catch` runs: the latch stays set, `scheduleReconnect()` is never called, and every subsequent
   * `onerror` short-circuits on the latch. The stream stays closed FOREVER. The app neither reconnects
   * nor returns to the access gate, and the operator is left looking at a stale panel with a "not live"
   * indicator.
   *
   * The shared HTTP wrapper now applies its own deadline to `accessStatus()`, so the real probe settles.
   * This is a second, independent bound at the point where the latch actually lives, so the stream cannot
   * be wedged by ANY injected probe.
   */
  probeTimeoutMs?: number;
  /** Factory for the underlying EventSource (injectable for tests). */
  create?: (url: string) => EventSourceLike;
  /** First backoff delay in ms. Default 1000. */
  baseDelayMs?: number;
  /** Backoff ceiling in ms — the cap. Default 30000. */
  maxDelayMs?: number;
  /** Scheduler (injectable for tests). Defaults to setTimeout/clearTimeout. */
  setTimeoutFn?: (fn: () => void, ms: number) => number;
  clearTimeoutFn?: (handle: number) => void;
}

function defaultCreate(url: string): EventSourceLike {
  // `withCredentials: true` is the whole point — the cookie rides on the SSE, no token in
  // the URL.
  return new EventSource(url, { withCredentials: true }) as unknown as EventSourceLike;
}

export class ReconnectingBoxStream {
  private opts: Required<
    Pick<ReconnectingSseOptions, "baseDelayMs" | "maxDelayMs" | "create" | "setTimeoutFn" | "clearTimeoutFn">
  > &
    ReconnectingSseOptions;
  private es: EventSourceLike | null = null;
  private attempt = 0;
  private timer: number | null = null;
  private stopped = false;
  private probing = false;

  constructor(options: ReconnectingSseOptions) {
    this.opts = {
      baseDelayMs: 1000,
      maxDelayMs: 30000,
      create: defaultCreate,
      setTimeoutFn: (fn, ms) => setTimeout(fn, ms) as unknown as number,
      clearTimeoutFn: (h) => clearTimeout(h),
      ...options,
    };
  }

  /** Backoff for a given attempt (0-based), capped at maxDelayMs. Exposed for tests. */
  backoffFor(attempt: number): number {
    const raw = this.opts.baseDelayMs * 2 ** attempt;
    return Math.min(raw, this.opts.maxDelayMs);
  }

  start(): void {
    this.stopped = false;
    this.open();
  }

  private open(): void {
    if (this.stopped) return;
    const es = this.opts.create(this.opts.url);
    this.es = es;

    for (const type of this.opts.events) {
      es.addEventListener(type, (ev) => {
        this.opts.onEvent(type, (ev as MessageEvent).data);
      });
    }

    es.onopen = () => {
      // A successful open resets the backoff so the next transient drop starts from base.
      this.attempt = 0;
      this.opts.onOpen?.();
    };

    es.onerror = () => {
      this.handleError();
    };
  }

  private handleError(): void {
    if (this.stopped) return;
    this.opts.onDisconnect?.();
    // Close the failed source before deciding what to do; a half-open source must never
    // leak into a reconnect.
    this.es?.close();
    this.es = null;

    if (this.probing) return; // a probe is already deciding
    this.probing = true;

    void this.boundedProbe()
      .then((unauthorized) => {
        this.probing = false;
        if (this.stopped) return;
        if (unauthorized) {
          // Session is gone: stop for good and notify. NO reconnect after a 401.
          this.stop();
          this.opts.onUnauthorized();
          return;
        }
        this.scheduleReconnect();
      })
      .catch(() => {
        // If the probe itself failed (network still down), treat as transient and back off.
        this.probing = false;
        if (!this.stopped) this.scheduleReconnect();
      });
  }

  /**
   * The auth probe, with its own deadline.
   *
   * A probe that never settles used to wedge the `probing` latch permanently, which stopped the stream
   * reconnecting AND stopped it ever tearing down to the access gate. Racing it against a timer means the
   * latch is always released.
   *
   * A TIMED-OUT PROBE RESOLVES FALSE — "transient", so the stream backs off and retries. That direction
   * is deliberate: resolving true would call `onUnauthorized()` and stop for good, tearing a working
   * session down to the login screen because one probe was slow. The existing `catch { return true }` in
   * the app's probe already errs the other way for a FAILED probe; a TIMEOUT is weaker evidence than a
   * failure, so it must not be treated as proof the session is gone.
   *
   * The timer is cleared whichever side wins, so nothing accumulates across reconnects.
   */
  private boundedProbe(): Promise<boolean> {
    const limit = this.opts.probeTimeoutMs ?? 10_000;
    const probe = this.opts.probeUnauthorized();
    if (limit <= 0) return probe;
    return new Promise<boolean>((resolve, reject) => {
      let settled = false;
      const handle = this.opts.setTimeoutFn(() => {
        if (settled) return;
        settled = true;
        // Transient, not unauthorized. See the docblock.
        resolve(false);
      }, limit);
      probe.then(
        (value) => {
          if (settled) return;
          settled = true;
          this.opts.clearTimeoutFn(handle);
          resolve(value);
        },
        (error) => {
          if (settled) return;
          settled = true;
          this.opts.clearTimeoutFn(handle);
          reject(error);
        },
      );
    });
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    const delay = this.backoffFor(this.attempt);
    this.attempt += 1;
    this.timer = this.opts.setTimeoutFn(() => {
      this.timer = null;
      this.open();
    }, delay);
  }

  /** Close the stream and cancel any pending reconnect. Idempotent. */
  stop(): void {
    this.stopped = true;
    if (this.timer !== null) {
      this.opts.clearTimeoutFn(this.timer);
      this.timer = null;
    }
    this.es?.close();
    this.es = null;
  }
}
