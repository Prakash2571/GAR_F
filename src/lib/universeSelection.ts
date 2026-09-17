/**
 * PRE-RUN UNIVERSE SELECTION — the picker's staging arithmetic, as pure functions.
 *
 * WHY THIS IS NOT INSIDE THE COMPONENT
 *
 * The picker stages changes locally and sends them as a DIFF, and the diff is the part that can be
 * dangerous. One direction of error matters far more than the other: failing to exclude a name leaves
 * it tradable, which the operator can see and fix, whereas an accidental RE-INCLUSION re-opens entry on
 * something they deliberately declined — silently, because nothing on screen changes when a name goes
 * back to being merely ordinary. So the arithmetic lives here where it can be tested directly, on the
 * same functions the component calls, rather than being asserted through a rendered checkbox.
 *
 * THE INVARIANT EVERYTHING ELSE RESTS ON
 *
 * The staged map holds a DESIRED state per symbol, and {@link stagedDiff} only ever emits a symbol
 * whose desired state DIFFERS from what the server currently reports. A row toggled twice therefore
 * contributes nothing at all — it does not appear in `include` as a "restore", which would be
 * indistinguishable at the API from a deliberate re-admission.
 */

import type { UniverseUnderlying } from "../api/types.ts";

/**
 * Which slice of the universe the picker is showing.
 *
 * `watched` and `watchable` are DIFFERENT slices and both are needed. `watchable` is what nothing
 * forbids; `watched` is what the engine actually holds a window for. Offering only the former is what
 * let a deployment watching one underlying present itself as watching 215.
 */
export type UniverseFilter = "all" | "watched" | "watchable" | "excluded" | "blocked";

/** symbol → DESIRED excluded state. Absent means "leave whatever the server says". */
export type StagedExclusions = ReadonlyMap<string, boolean>;

/**
 * The deltas to send, and nothing more.
 *
 * A symbol is emitted ONLY when its staged desire differs from the server's current state, so the
 * request carries real changes rather than a restatement of the whole set. That is what makes the
 * write safe to repeat and impossible to misread as a set replacement.
 */
export function stagedDiff(
  rows: readonly UniverseUnderlying[],
  staged: StagedExclusions,
): { toExclude: string[]; toInclude: string[] } {
  const toExclude: string[] = [];
  const toInclude: string[] = [];
  for (const row of rows) {
    const want = staged.get(row.symbol);
    if (want === undefined || want === row.excluded) continue;
    if (want) toExclude.push(row.symbol);
    else toInclude.push(row.symbol);
  }
  return { toExclude, toInclude };
}

/** The desired state of one row: the staged value when present, otherwise the server's. */
export function isStagedExcluded(row: UniverseUnderlying, staged: StagedExclusions): boolean {
  return staged.get(row.symbol) ?? row.excluded;
}

/**
 * Stage `subset` to a single desired state.
 *
 * A row already in that state is REMOVED from the staging map rather than recorded as a no-op, so
 * "exclude everything shown" over a list that is mostly already excluded produces a small diff
 * instead of a large one that happens to change nothing.
 */
export function stageMany(
  staged: StagedExclusions,
  subset: readonly UniverseUnderlying[],
  want: boolean,
): StagedExclusions {
  const next = new Map(staged);
  for (const row of subset) {
    if (want === row.excluded) next.delete(row.symbol);
    else next.set(row.symbol, want);
  }
  return next;
}

/** Flip one row's desired state. Toggling back to the server's value clears the entry entirely. */
export function toggleStaged(staged: StagedExclusions, row: UniverseUnderlying): StagedExclusions {
  return stageMany(staged, [row], !isStagedExcluded(row, staged));
}

/**
 * Search + filter, matching on symbol OR display name.
 *
 * The query is upper-cased on both sides rather than lower-cased, because symbols are canonically
 * upper case and an operator types them that way.
 */
export function filterUniverse(
  rows: readonly UniverseUnderlying[],
  query: string,
  filter: UniverseFilter,
): UniverseUnderlying[] {
  const q = query.trim().toUpperCase();
  return rows.filter((row) => {
    if (q !== "" && !row.symbol.includes(q) && !row.name.toUpperCase().includes(q)) return false;
    switch (filter) {
      case "watched":
        // Ground truth from the engine, including excluded names that keep a window because they
        // carry exposure — the feed is genuinely carrying them.
        return row.watched;
      case "watchable":
        return !row.excluded && row.admissible;
      case "excluded":
        return row.excluded;
      case "blocked":
        // NOT excluded, and still unable to trade. Excluded names are deliberately left out: the
        // operator already decided about those, so listing them here would bury the ones that look
        // enabled and are not.
        return !row.excluded && !row.admissible;
      default:
        return true;
    }
  });
}

/** Names that are not excluded and cannot trade anyway — the silently-dead set. */
export function capBlocked(rows: readonly UniverseUnderlying[]): UniverseUnderlying[] {
  return rows.filter((row) => !row.excluded && !row.admissible);
}
