/**
 * THE PRE-RUN UNIVERSE PICKER — choose what NOT to enter, from the actual F&O board.
 *
 * WHY THIS EXISTS
 *
 * The blocklist could only ever be edited by TYPING a symbol, which quietly required the operator to
 * already know every name they might want to decline. With one configured underlying that was fine.
 * Watching the whole F&O universe makes it useless: a deny list you cannot browse is a deny list you
 * cannot use. This fetches the real board and turns the decision into reading and unticking.
 *
 * THREE THINGS THIS IS CAREFUL ABOUT
 *
 * 1. NOTHING IS SENT UNTIL "APPLY". Ticking a row stages a change locally. Two reasons, and the
 *    second is the real one: backend-side each single-symbol write triggers a FULL universe rebuild
 *    (a fresh instrument-master fetch and a re-derivation of every window), so eighty individual
 *    exclusions would be eighty rebuilds; and screening a universe is ONE decision the operator
 *    should be able to review before committing. Apply sends the whole batch as a diff.
 *
 * 2. "CANNOT TRADE" IS SHOWN SEPARATELY FROM "WILL NOT TRADE". `excluded` is the operator's own
 *    decision; `admissible` is whether the current quantity caps permit the name at all. A name whose
 *    lot exceeds BOX_LIVE_MAX_OPEN_LEG_QUANTITY is not unlikely to trade — it CANNOT, and the backend
 *    refusal happens deep on the entry path where it reads like an execution fault. Those names are
 *    counted, explained and offered as a one-click batch, because they are the ones that look enabled
 *    and are not.
 *
 * 3. `built: false` IS NOT AN EMPTY UNIVERSE. It means no universe pass has completed. Rendering it
 *    as "no underlyings" would tell the operator the instrument master is broken.
 *
 * The staged set is keyed by symbol and holds the DESIRED state, so a row toggled back to where it
 * started drops out of the diff entirely and the request stays minimal.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  applyExcludedUnderlyingsBulk,
  fetchBoxUniverse,
  type BoxExcludedUnderlyings,
  type BoxUniverse,
  type UniverseUnderlying,
} from "../../api";
import {
  capBlocked,
  filterUniverse,
  isStagedExcluded,
  stagedDiff,
  stageMany,
  toggleStaged,
  type StagedExclusions,
  type UniverseFilter,
} from "../../lib/universeSelection.ts";

const FILTERS: { key: UniverseFilter; label: string; hint: string }[] = [
  { key: "all", label: "All", hint: "Every underlying with a resolved option chain" },
  {
    key: "watched",
    label: "Watching",
    hint: "Underlyings the engine currently holds a live window for — what it is ACTUALLY observing",
  },
  {
    key: "watchable",
    label: "Eligible",
    hint: "Not excluded and inside the quantity caps. What nothing forbids — an upper bound, not what is being watched",
  },
  { key: "excluded", label: "Excluded", hint: "On the blocklist: no new box will be entered" },
  { key: "blocked", label: "Cap-blocked", hint: "Not excluded, but the quantity caps make entry impossible" },
];

function fmtWhen(at: number | null): string {
  if (at === null || !Number.isFinite(at) || at <= 0) return "—";
  return new Date(at).toLocaleTimeString("en-IN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
    timeZone: "Asia/Kolkata",
  });
}

/**
 * Why a name is not being observed, in operator language.
 *
 * `underlying_cap` names the VARIABLE rather than describing the effect, because that is the one an
 * operator can change and the one that was previously mis-attributed to the token budget.
 */
function notWatchedLabel(row: UniverseUnderlying, maxUnderlyings: number): string {
  switch (row.not_watched_reason) {
    case "excluded":
      return "you excluded it";
    case "underlying_cap":
      return `BOX_MAX_UNDERLYINGS is ${maxUnderlyings}, and this name fell outside it`;
    case "token_budget":
      return "the live-feed token budget ran out before this name";
    case "discovery_off":
      return "the scanner is stopped";
    default:
      return "no reason reported";
  }
}

/** Short label for why a name cannot trade, for the row badge. The full sentence is the tooltip. */
function reasonLabel(row: UniverseUnderlying): string {
  switch (row.inadmissible_reason) {
    case "lot_exceeds_per_leg_cap":
      return "LOT > CAP";
    case "four_legs_exceed_gross_cap":
      return "4 LEGS > GROSS";
    case "no_paired_strikes":
      return "NO PAIRED STRIKES";
    case "unusable_lot_size":
      return "NO LOT SIZE";
    default:
      return "";
  }
}

export function UniversePicker({
  canTrade,
  isFullAdmin,
  persistent,
  universeBuiltAt,
  onChanged,
}: {
  canTrade: boolean;
  isFullAdmin: boolean;
  /** From `status.excluded_underlyings.persistent` — false ⇒ nothing can be saved. */
  persistent: boolean;
  /**
   * `status.universe_built_at` — the engine's own stamp for its last universe pass.
   *
   * THE FIX FOR AN EMPTY PICKER. This component used to fetch once on mount and never again, and the
   * universe becomes available ASYNCHRONOUSLY: `boot()` fetches ~113k instruments, so a tab opened
   * during that window got `built: false` and kept showing "no universe pass has completed yet"
   * forever, while every other panel updated off the status stream. Re-reading when this stamp changes
   * ties the refresh to the authoritative signal rather than to a blind timer, so the list appears as
   * soon as there is one and refreshes whenever the engine rebuilds.
   */
  universeBuiltAt: number | null;
  /** Hand the authoritative post-write blocklist back to the page. */
  onChanged: (next: BoxExcludedUnderlyings) => void;
}) {
  const [universe, setUniverse] = useState<BoxUniverse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [applying, setApplying] = useState(false);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<UniverseFilter>("all");
  /**
   * symbol → DESIRED excluded state. Only rows that differ from the server are kept, so a row
   * toggled back to where it started drops out of the diff entirely.
   *
   * A Map rather than a plain object: the keys are broker-supplied symbols, and an object index
   * would let a name like `constructor` collide with something on the prototype.
   */
  const [staged, setStaged] = useState<StagedExclusions>(new Map());

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setUniverse(await fetchBoxUniverse());
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load the tradable universe.");
    } finally {
      setLoading(false);
    }
  }, []);

  // Re-read on mount AND whenever the engine completes a universe pass. Staged ticks deliberately
  // SURVIVE a refresh: `staged` is untouched here, and `stagedDiff` re-derives against the fresh rows,
  // so a background rebuild cannot silently discard an operator's half-finished screening.
  useEffect(() => {
    if (canTrade) void load();
  }, [canTrade, load, universeBuiltAt]);

  const rows = universe?.underlyings ?? [];

  /** The diff to send: only symbols whose staged state actually differs from the server's. */
  const { toExclude, toInclude } = useMemo(() => stagedDiff(rows, staged), [rows, staged]);

  const visible = useMemo(() => filterUniverse(rows, query, filter), [rows, query, filter]);

  if (!canTrade) return null;

  const writable = isFullAdmin && persistent;
  const pending = toExclude.length + toInclude.length;
  const blockedRows = capBlocked(rows);

  function toggle(row: UniverseUnderlying) {
    setNote(null);
    setStaged((prev) => toggleStaged(prev, row));
  }

  /** Stage every visible row to a single desired state — the bulk gesture the picker exists for. */
  function stageAll(want: boolean, subset: readonly UniverseUnderlying[]) {
    setNote(null);
    setStaged((prev) => stageMany(prev, subset, want));
  }

  async function apply() {
    if (pending === 0) return;
    setApplying(true);
    setError(null);
    setNote(null);
    try {
      const result = await applyExcludedUnderlyingsBulk({
        exclude: toExclude.map((symbol) => ({ symbol, reason: "declined in pre-run screening" })),
        include: toInclude,
      });
      onChanged(result.blocklist);
      setStaged(new Map());
      // Re-read the universe: every row's `excluded` flag is now stale, and the backend has just
      // rebuilt the universe, so this is also the honest post-write view of what will be watched.
      await load();
      setNote(
        `Applied — ${result.added} excluded, ${result.removed} re-included. ` +
          `Boxes already open on a newly excluded name are unaffected: they keep streaming and still exit.`,
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to apply the blocklist changes.");
    } finally {
      setApplying(false);
    }
  }

  return (
    <section className="box-universe">
      <header className="box-universe-h">
        <span>Universe picker</span>
        {universe !== null && <span className="pill-count">{universe.summary.total}</span>}
        {universe !== null && !universe.blocklist_readable && (
          <span className="box-exec-badge box-exec-badge--danger">ENTRY REFUSED</span>
        )}
        <button
          type="button"
          className="btn btn--sm box-universe-reload"
          disabled={loading || applying}
          onClick={() => void load()}
          title="Re-read the board. Cheap: it is already in the engine's memory and fetches nothing."
        >
          {loading ? "Loading…" : "Refresh"}
        </button>
      </header>

      <p className="box-universe-sub">
        Every underlying with a resolved option chain. Tick a name to refuse <strong>new entry</strong>{" "}
        on it in every execution mode — nothing is sent until you press Apply. Exits, reductions and
        protective cancels are never affected, so excluding a name cannot trap a position already open.
      </p>

      {error !== null && <p className="box-exclusions-msg box-exclusions-msg--error">{error}</p>}

      {universe !== null && !universe.blocklist_readable && (
        <p className="box-exclusions-msg box-exclusions-msg--error">
          The blocklist could not be read, so the backend is refusing <strong>every</strong> new entry —
          a list it cannot read cannot confirm that any name is permitted. Nothing below will be
          entered regardless of what it shows. Exits and protective cancels still work.
        </p>
      )}

      {universe !== null && !universe.built && (
        <p className="box-exclusions-msg box-exclusions-msg--warn">
          No universe pass has completed yet, so this list is empty — that is <strong>not</strong> an
          empty universe. The board is built once at boot and again on each refresh cycle; reload in a
          moment.
        </p>
      )}

      {universe !== null && (
        <>
          <dl className="box-universe-stats">
            {/*
              WATCHED FIRST, and it is not the same as WATCHABLE. This panel originally showed only
              "watchable" — not excluded and admissible — which reads as "being watched" and is not:
              it ignores BOX_MAX_UNDERLYINGS and the token budget entirely. On a real deployment it
              said 215 while exactly ONE underlying had a window.
            */}
            <div className={universe.summary.watched === 0 ? "is-warn" : undefined}>
              <dt>Watching now</dt>
              <dd title="Underlyings the engine currently holds a live window for — what it is ACTUALLY observing.">
                {universe.summary.watched}
              </dd>
            </div>
            <div>
              <dt>Eligible</dt>
              <dd title="Neither excluded nor cap-blocked. This is what nothing FORBIDS — an upper bound, not what is being watched.">
                {universe.summary.watchable}
              </dd>
            </div>
            <div>
              <dt>Excluded</dt>
              <dd title="On the operator blocklist. No new box will be entered on these.">
                {universe.summary.excluded}
              </dd>
            </div>
            <div className={universe.summary.blocked_by_caps > 0 ? "is-warn" : undefined}>
              <dt>Cap-blocked</dt>
              <dd title="NOT excluded, and still unable to trade under the current quantity caps. These look enabled and are not.">
                {universe.summary.blocked_by_caps}
              </dd>
            </div>
            <div>
              <dt>Indices</dt>
              <dd>{universe.summary.indices}</dd>
            </div>
            <div>
              <dt>In board</dt>
              <dd>{universe.summary.total}</dd>
            </div>
            <div>
              <dt>Built</dt>
              <dd className="box-dim">{fmtWhen(universe.built_at)}</dd>
            </div>
          </dl>

          {/*
            THE GAP BETWEEN ELIGIBLE AND WATCHED, explained by naming the setting responsible.
            Non-zero means a CAP is deciding what gets looked at, not the market — and this is the
            banner that answers "so which ones is it actually monitoring?".
          */}
          {universe.summary.eligible_not_watched > 0 && (
            <p className="box-exclusions-msg box-exclusions-msg--warn">
              {universe.summary.eligible_not_watched} eligible underlying
              {universe.summary.eligible_not_watched === 1 ? " is" : "s are"} <strong>not</strong>{" "}
              being observed
              {universe.max_underlyings > 0 ? (
                <>
                  {" "}
                  because <strong>BOX_MAX_UNDERLYINGS is {universe.max_underlyings}</strong>, which
                  caps the universe to the first {universe.max_underlyings} name
                  {universe.max_underlyings === 1 ? "" : "s"} in board order — indices first, then
                  alphabetical. Set it to <strong>0</strong> for no cap. This is not the token budget
                  ({universe.max_subscribed_tokens} instruments), which is unaffected.
                </>
              ) : (
                <>
                  {" "}
                  — the live-feed token budget ({universe.max_subscribed_tokens} instruments) ran out.
                  A narrower strike level costs fewer tokens per name.
                </>
              )}
            </p>
          )}

          {!universe.discovering && (
            <p className="box-exclusions-msg box-exclusions-msg--warn">
              The scanner is stopped, so nothing is being observed at all — whatever the caps allow.
              Counts below describe what <em>would</em> be watched once you press RUN.
            </p>
          )}

          <p className="box-universe-caps box-dim">
            Judged against per-leg{" "}
            <strong>
              {universe.caps.max_open_leg_quantity === 0 ? "no limit" : universe.caps.max_open_leg_quantity}
            </strong>{" "}
            and gross{" "}
            <strong>
              {universe.caps.max_gross_open_leg_quantity === 0
                ? "no limit"
                : universe.caps.max_gross_open_leg_quantity}
            </strong>{" "}
            units. One box needs four legs of one lot, so the gross cap binds at a quarter of its face
            value.
          </p>

          {/*
            THE HAZARD OF A WIDE UNIVERSE, STATED WHERE IT IS ACTIONABLE. The per-leg cap is one global
            number and F&O lot sizes span orders of magnitude, so across the whole universe some names
            are always impossible. Set the cap to the largest lot you will trade, then exclude the rest.
          */}
          {blockedRows.length > 0 && (
            <p className="box-exclusions-msg box-exclusions-msg--warn">
              {blockedRows.length} name{blockedRows.length === 1 ? "" : "s"} cannot trade under the
              current quantity caps but {blockedRows.length === 1 ? "is" : "are"} not excluded — every
              entry on {blockedRows.length === 1 ? "it" : "them"} is refused before the first leg is
              sent, which reads as an execution failure rather than a configuration mismatch.{" "}
              {writable && (
                <button
                  type="button"
                  className="btn btn--sm"
                  disabled={applying}
                  onClick={() => stageAll(true, blockedRows)}
                  title="Stage all cap-blocked names for exclusion. Still needs Apply."
                >
                  Stage all {blockedRows.length}
                </button>
              )}
            </p>
          )}

          <div className="box-universe-tools">
            <input
              className="box-universe-search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol or name…"
              spellCheck={false}
              aria-label="Search the universe"
            />
            <div className="box-universe-filters" role="group" aria-label="Filter the universe">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  className={`btn btn--sm${filter === f.key ? " is-active" : ""}`}
                  onClick={() => setFilter(f.key)}
                  title={f.hint}
                  aria-pressed={filter === f.key}
                >
                  {f.label}
                </button>
              ))}
            </div>
          </div>

          {writable && visible.length > 0 && (
            <div className="box-universe-bulk">
              <span className="box-dim">
                {visible.length} shown{query.trim() === "" && filter === "all" ? "" : " by this filter"}
              </span>
              <button
                type="button"
                className="btn btn--sm"
                disabled={applying}
                onClick={() => stageAll(true, visible)}
                title="Stage every name shown for exclusion. Still needs Apply."
              >
                Exclude shown
              </button>
              <button
                type="button"
                className="btn btn--sm"
                disabled={applying}
                onClick={() => stageAll(false, visible)}
                title="Stage every name shown to be tradable again. Still needs Apply."
              >
                Allow shown
              </button>
            </div>
          )}

          {visible.length === 0 ? (
            <p className="box-exclusions-empty">
              {rows.length === 0
                ? "No underlyings to show."
                : "No underlying matches this search and filter."}
            </p>
          ) : (
            <ul className="box-universe-list">
              {visible.map((row) => {
                const ticked = isStagedExcluded(row, staged);
                const changed = staged.has(row.symbol);
                return (
                  <li
                    key={row.symbol}
                    className={`box-universe-row${ticked ? " is-excluded" : ""}${changed ? " is-staged" : ""}`}
                  >
                    <label className="box-universe-pick">
                      <input
                        type="checkbox"
                        checked={ticked}
                        disabled={!writable || applying}
                        onChange={() => toggle(row)}
                        aria-label={`Refuse new entry on ${row.symbol}`}
                      />
                      <span className="box-universe-sym">{row.symbol}</span>
                    </label>
                    <span className="box-universe-name box-dim">{row.name}</span>
                    {row.is_index && <span className="box-universe-tag">INDEX</span>}
                    {/*
                      IS THE ENGINE LOOKING AT THIS ONE? The question the summary counts answer in
                      aggregate, answered per row so "which one is it monitoring?" is readable rather
                      than inferred. Deliberately distinct from the cap badge: not-watched is a
                      universe-membership fact, cap-blocked is a quantity fact.
                    */}
                    {row.watched ? (
                      <span
                        className="box-universe-live"
                        title="The engine holds a live window for this underlying and is observing it."
                      >
                        WATCHING
                      </span>
                    ) : (
                      <span
                        className="box-universe-idle"
                        title={`Not observed: ${notWatchedLabel(row, universe.max_underlyings)}.`}
                      >
                        NOT WATCHED
                      </span>
                    )}
                    <span
                      className="box-universe-lot box-dim"
                      title={`One lot is ${row.lot_size} unit(s); four legs need ${row.lot_size * 4}.`}
                    >
                      {row.lot_size === 0 ? "lot —" : `lot ${row.lot_size}`}
                    </span>
                    <span className="box-universe-exp box-dim">{row.expiry ?? "—"}</span>
                    <span
                      className="box-universe-strikes box-dim"
                      title="Strikes carrying BOTH a CE and a PE. A box needs two."
                    >
                      {row.paired_strikes}k
                    </span>
                    {!row.admissible && (
                      <span
                        className="box-universe-bad"
                        title={row.inadmissible_detail ?? "This name cannot trade under the current caps."}
                      >
                        {reasonLabel(row)}
                      </span>
                    )}
                    {row.excluded && row.excluded_reason !== null && (
                      <span className="box-universe-why box-dim">{row.excluded_reason}</span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}

      {/*
        THE COMMIT BAR. Shows the diff in both directions before it is sent, because the dangerous
        direction is the quiet one: RE-ADMITTING a name re-opens entry on something previously
        declined, and that must never happen as an unnoticed side effect of ticking around.
      */}
      {writable && (
        <div className="box-universe-apply">
          <span className={pending > 0 ? "box-universe-pending" : "box-dim"}>
            {pending === 0
              ? "No staged changes."
              : `${toExclude.length} to exclude, ${toInclude.length} to re-include.`}
          </span>
          {pending > 0 && (
            <button
              type="button"
              className="btn btn--sm"
              disabled={applying}
              onClick={() => {
                setStaged(new Map());
                setNote(null);
              }}
            >
              Discard
            </button>
          )}
          <button
            type="button"
            className="btn btn--primary btn--sm"
            disabled={applying || pending === 0}
            onClick={() => void apply()}
            title={
              pending === 0
                ? "Tick a name to stage a change."
                : `Write ${pending} change(s) in one transaction, with one universe rebuild.`
            }
          >
            {applying ? "Applying…" : `Apply ${pending === 0 ? "" : pending}`}
          </button>
        </div>
      )}

      {!writable && (
        <p className="box-exclusions-note box-dim">
          {isFullAdmin
            ? "The blocklist cannot be edited while box persistence is unavailable — an exclusion could not be saved and would be lost on the next restart."
            : "Full administrator access is required to change the blocklist. The universe is shown read-only."}
        </p>
      )}

      {note !== null && error === null && (
        <p className="box-exclusions-msg box-exclusions-msg--ok">{note}</p>
      )}
    </section>
  );
}
