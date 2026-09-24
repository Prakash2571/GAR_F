/**
 * Barrel re-export of the focused API modules.
 *
 * The ported Box components import types and calls from `"./api"`. Rather than rewrite
 * every import, this thin barrel re-exports the real modules under `src/api/`. It contains
 * NO logic and NO 2,623-line monolith — just the public surface the Box UI needs.
 */

export * from "./api/types.ts";
export * from "./api/box.ts";
export {
  API_ORIGIN,
  ApiError,
  describeRequestFailure,
  isUnknownOutcome,
  MissingCsrfTokenError,
  NetworkError,
  onUnauthorized,
  refusalReason,
  RequestTimeoutError,
  UnauthorizedError,
} from "./api/http.ts";
