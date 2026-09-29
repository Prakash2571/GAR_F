/**
 * The Synthetic page's live-update pipeline, built so React only does the work that changed.
 *
 *   1. FRAMES. A snapshot is the whole state (~250 KB of JSON). `LatestFrame` keeps only the
 *      newest raw frame and parses it once, on the next animation frame: several frames that
 *      arrive within one frame cost one parse and one render, and a hidden tab parses nothing
 *      until it is shown again (the newest state then lands at once).
 *   2. SHARING. `shareEqual(prev, next)` returns `next` rebuilt so every part equal to `prev`
 *      IS `prev` (the same object). Rows are matched by their identity (key / id / role /
 *      client order id), not by position, so a row that merely moved in the ranking is reused.
 *      With memoised rows and cards, React then re-renders only what actually changed.
 *   3. FORMATTING. `toLocaleString("en-IN")` builds a formatter on every call (~18 µs);
 *      the cached `Intl.NumberFormat` here gives byte-identical text ~35× faster.
 *
 * Pure (no React): unit-tested directly.
 */

/* --------------------------------- frames --------------------------------- */

export interface FrameScheduler {
  schedule: (fn: () => void) => number;
  cancel: (handle: number) => void;
}

function defaultScheduler(): FrameScheduler {
  if (typeof requestAnimationFrame === "function") {
    return { schedule: (fn) => requestAnimationFrame(() => fn()), cancel: (h) => cancelAnimationFrame(h) };
  }
  return { schedule: (fn) => setTimeout(fn, 16) as unknown as number, cancel: (h) => clearTimeout(h) };
}

/** Keeps only the newest frame and applies it, parsed, on the next animation frame. */
export class LatestFrame<T> {
  private raw: string | null = null;
  private handle: number | null = null;
  private readonly sched: FrameScheduler;
  private readonly apply: (value: T) => void;
  private readonly parse: (raw: string) => T;
  /** Frames received / frames actually parsed and applied (for diagnostics and tests). */
  received = 0;
  applied = 0;

  constructor(apply: (value: T) => void, scheduler?: FrameScheduler, parse?: (raw: string) => T) {
    this.apply = apply;
    this.sched = scheduler ?? defaultScheduler();
    this.parse = parse ?? ((raw) => JSON.parse(raw) as T);
  }

  push(raw: string): void {
    this.received++;
    this.raw = raw;
    if (this.handle === null) this.handle = this.sched.schedule(() => this.flush());
  }

  /** Apply the newest pending frame now (a malformed frame is dropped). */
  flush(): void {
    this.handle = null;
    const raw = this.raw;
    this.raw = null;
    if (raw === null) return;
    let value: T;
    try {
      value = this.parse(raw);
    } catch {
      return;
    }
    this.applied++;
    this.apply(value);
  }

  stop(): void {
    if (this.handle !== null) this.sched.cancel(this.handle);
    this.handle = null;
    this.raw = null;
  }
}

/* --------------------------------- sharing -------------------------------- */

/** Fields that change on every evaluation but are never shown (else a quiet market still re-renders). */
const IGNORED = new Set(["updated_at", "server_time", "evaluated_at"]);

/** Live book ages: equal when they DISPLAY the same (see `liveAgeText`). */
const AGES = new Set(["age_ms", "worst_age_ms", "feed_age_ms"]);

/** A live book age, coarse on purpose: a table at 4 updates/s would otherwise flicker. */
export function liveAgeText(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return "-";
  if (ms < 1000) return "<1s";
  if (ms < 60_000) return `${Math.floor(ms / 1000)}s`;
  return `${Math.floor(ms / 60_000)}m`;
}

function identityOf(v: unknown): string | null {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  for (const k of ["key", "id", "client_order_id", "role"]) {
    const x = o[k];
    if (typeof x === "string" && x !== "") return `${k}:${x}`;
  }
  return null;
}

function shareArray(prev: unknown[], next: unknown[]): unknown[] {
  const byId = new Map<string, unknown>();
  for (const p of prev) {
    const id = identityOf(p);
    if (id !== null) byId.set(id, p);
  }
  let same = prev.length === next.length;
  const out = next.map((n, i) => {
    // By identity when the element has one (rows move as the ranking changes), else by position.
    const id = identityOf(n);
    const match = id !== null ? byId.get(id) : identityOf(prev[i]) === null ? prev[i] : undefined;
    const v = match === undefined ? n : shareEqual(match, n);
    if (v !== prev[i]) same = false;
    return v;
  });
  return same ? prev : out;
}

function shareObject(prev: Record<string, unknown>, next: Record<string, unknown>): Record<string, unknown> {
  const nextKeys = Object.keys(next);
  let same = nextKeys.length === Object.keys(prev).length;
  const out: Record<string, unknown> = {};
  for (const k of nextKeys) {
    const p = prev[k];
    const n = next[k];
    let v: unknown;
    if (IGNORED.has(k) && k in prev) {
      v = p;
    } else if (AGES.has(k) && (typeof n === "number" || n === null) && (typeof p === "number" || p === null)) {
      v = liveAgeText(p as number | null) === liveAgeText(n as number | null) ? p : n;
    } else {
      v = shareEqual(p, n);
    }
    if (v !== p || !(k in prev)) same = false;
    out[k] = v;
  }
  return same ? prev : out;
}

/**
 * `next`, with every part that equals `prev` replaced by `prev` itself (structural sharing).
 * Returns `prev` when nothing that is displayed changed.
 */
export function shareEqual<T>(prev: T, next: T): T {
  if (Object.is(prev, next)) return prev;
  if (prev === null || next === null || typeof prev !== "object" || typeof next !== "object") return next;
  if (Array.isArray(prev) !== Array.isArray(next)) return next;
  if (Array.isArray(prev)) return shareArray(prev, next as unknown as unknown[]) as unknown as T;
  return shareObject(prev as Record<string, unknown>, next as Record<string, unknown>) as T;
}

/* -------------------------------- formatting ------------------------------- */

const inr = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 2 });
const whole = new Intl.NumberFormat("en-IN");
const expiryCache = new Map<string, string>();

/** Same text as format.ts `fmtMoney`, with a cached formatter. */
export function money(value: number | null | undefined): string {
  if (value === null || value === undefined || Number.isNaN(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "−" : "";
  return `${sign}₹${inr.format(Math.abs(value))}`;
}

/** Same text as format.ts `fmt`. */
export function num2(value: number | null | undefined, dash = "-"): string {
  if (value === null || value === undefined || Number.isNaN(value)) return dash;
  return value.toFixed(2);
}

/** ₹ with Indian digit grouping, no sign (margins). */
export function rupees(value: number): string {
  return `₹${whole.format(Math.round(value))}`;
}

/** Same text as format.ts `formatExpiry` ("26 Jul"), memoised per date. */
export function expiryLabel(expiry: string): string {
  let s = expiryCache.get(expiry);
  if (s === undefined) {
    const d = new Date(`${expiry}T00:00:00`);
    s = Number.isNaN(d.getTime()) ? expiry : d.toLocaleDateString("en-GB", { day: "numeric", month: "short" });
    if (expiryCache.size > 500) expiryCache.clear();
    expiryCache.set(expiry, s);
  }
  return s;
}
