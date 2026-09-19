/**
 * THE OPERATOR CONFIGURATION API CLIENT.
 *
 * Two calls, both through the single `request` wrapper in `http.ts`, so they share its CSRF handling,
 * credentialed same-origin policy, 401 notification and error shaping with every other endpoint.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * THE PATCH ALWAYS CARRIES A VERSION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * `version` is REQUIRED by this signature, not optional, and the backend treats an absent version as
 * stale rather than as "force". That asymmetry is deliberate on both sides: a client that cannot say
 * which configuration it is editing must not be able to overwrite a risk limit, and making the
 * permissive case the default is how a version check comes to be bypassed everywhere.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * A REFUSAL IS A VALUE, NOT AN EXCEPTION
 * ─────────────────────────────────────────────────────────────────────────────────────────────
 * 409 (stale), 422 (validation/policy) and 403 (role) are EXPECTED outcomes on this surface: they are
 * how the backend explains that a change was refused and why. Letting them surface as thrown
 * `ApiError`s would push callers into parsing an error message to find the blockers, and a caller that
 * forgot would show "request failed" for a refusal that had a precise, actionable reason attached.
 *
 * So `patchOperatorConfig` resolves with a discriminated union. A genuine transport or server fault
 * still throws, because that is not a refusal — there is nothing to explain and nothing to act on
 * except retrying.
 */

import { apiUrl, request, ApiError } from "./http.ts";
import type {
  OperatorConfigContract,
  OperatorConfigRefusalContract,
} from "./contract.generated.ts";

export type OperatorConfig = OperatorConfigContract;
export type OperatorConfigRefusal = OperatorConfigRefusalContract;

/** The values a PATCH may carry, keyed by DOMAIN key — never by environment variable name. */
export type OperatorConfigChanges = Readonly<Record<string, boolean | number | string>>;

export type PatchResult =
  | { readonly outcome: "applied"; readonly config: OperatorConfig }
  | { readonly outcome: "refused"; readonly refusal: OperatorConfigRefusal };

/** Read the authoritative configuration. */
export async function fetchOperatorConfig(): Promise<OperatorConfig> {
  return request<OperatorConfig>(
    "/api/box/operator-config",
    "Failed to load the operator configuration",
  );
}

/**
 * Submit a change set.
 *
 * `changes` contains ONLY the fields being changed — the backend rejects unknown keys, so sending the
 * whole settings list back would be both wasteful and a way to accidentally rewrite a value another
 * operator changed in between.
 *
 * The refusal statuses are read off the response body rather than reconstructed from the status code
 * alone, because the body carries the current authoritative `version` and the per-field `problems`,
 * which is everything the caller needs to resynchronise and explain itself.
 */
export async function patchOperatorConfig(args: {
  readonly version: number;
  readonly changes: OperatorConfigChanges;
  readonly reason?: string;
}): Promise<PatchResult> {
  if (!Number.isInteger(args.version)) {
    // A non-integer version cannot have come from a payload we accepted, so this is a caller bug and
    // is worth failing loudly rather than sending a request the backend will reject as stale.
    throw new Error("patchOperatorConfig requires the integer version being edited.");
  }
  if (Object.keys(args.changes).length === 0) {
    throw new Error("patchOperatorConfig requires at least one change.");
  }

  try {
    const config = await request<OperatorConfig>(
      "/api/box/operator-config",
      "Failed to save the operator configuration",
      {
        method: "PATCH",
        body: {
          version: args.version,
          changes: args.changes,
          ...(args.reason === undefined ? {} : { reason: args.reason }),
        },
      },
    );
    return { outcome: "applied", config };
  } catch (error) {
    const refusal = refusalFrom(error);
    if (refusal !== null) return { outcome: "refused", refusal };
    throw error;
  }
}

/**
 * Recognise a structured refusal inside a thrown `ApiError`.
 *
 * Requires `applied === false` AND a non-empty `problems` array, i.e. the exact shape the contract
 * pins. A 409/422/403 whose body does NOT match is treated as a genuine error and rethrown — silently
 * coercing an unrecognised body into "refused" would let a proxy's HTML error page render as a
 * configuration refusal with no problems listed, which is precisely the silent refusal this surface
 * forbids.
 */
function refusalFrom(error: unknown): OperatorConfigRefusal | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 409 && error.status !== 422 && error.status !== 403) return null;

  const body = error.body;
  if (body === null || typeof body !== "object") return null;

  const candidate = body as Partial<OperatorConfigRefusal>;
  if (candidate.applied !== false) return null;
  if (typeof candidate.version !== "number") return null;
  if (!Array.isArray(candidate.problems) || candidate.problems.length === 0) return null;
  if (typeof candidate.reason !== "string") return null;

  return candidate as OperatorConfigRefusal;
}

/**
 * Does this error mean the backend has no operator-configuration endpoint at all?
 *
 * A `404` on this path is not a fault: the frontend ships ahead of the backend routes (see the
 * backend's `docs/OPERATOR_CONFIG.md` §7), so a deployment running an older or in-between build
 * answers 404 because the route genuinely does not exist. Callers use this to render an honest
 * "not available on this build" state instead of an error with a Retry button that can never succeed.
 *
 * Deliberately narrow — ONLY 404. A 401/403 means the session or role is wrong and must keep
 * surfacing as an error, and a 5xx is a real fault.
 */
export function isOperatorConfigUnavailable(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
}

/** The absolute URL, for callers that need it (diagnostics, tests). */
export function operatorConfigUrl(): string {
  return apiUrl("/api/box/operator-config");
}
