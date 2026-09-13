> ### Pinned backend commit
>
> `contract/BACKEND_CONTRACT.json` pins
> **`backend_sha = fd13a399871a62063d0628a618d83945a18c0e57`** — the `GTSAlgoResearch_B` commit
> (`docs: rebrand the backend as GTS Algo Research`, contract **1.9.0**) whose contract set
> hashes to the pinned `schemas_sha256`. Checking that SHA out in the backend reproduces this
> contract exactly, which is the whole point of the pin.
>
> 1.9.0 changed exactly one value: `protocol.json` `session_cookie_default`,
> `strikedge_session` → `gts_session`. `protocol.json` is hashed by `digest.mjs` alongside the
> schemas, so a protocol-constant change moves `schemas_sha256` exactly as a schema edit would
> — which is why the version bumped and everything below had to be re-pinned.
>
> **When you change the contract, update this SHA too.** `contract:verify` cannot check it:
> it verifies the DIGEST, which is content-addressed and will happily agree while the SHA
> points somewhere useless. Only the person making the change can confirm the SHA names the
> commit that contains the schemas — and the backend must merge FIRST (see step 8 below), so
> that the SHA exists on `main` before the frontend references it.

---

# Backend ⇄ Frontend API Contract (`contract/`) — VENDORED COPY (frontend)

This is the **frontend's vendored, pinned copy** of the backend-owned contract. It is a
verbatim `cp` of `GTSAlgoResearch_B/contract/` (`schemas/**`, `validate.mjs`, `digest.mjs`,
`version.json`, `protocol.json`) plus frontend-only tooling — `BACKEND_CONTRACT.json` (records
the pin), `verify.mjs` and `generate-types.mjs`. `protocol.json` holds the machine-readable
protocol constants (`csrf_header`, `session_cookie_default`, `csrf_cookie_suffix`); it is
covered by `digest.mjs` (hashed last, under the logical name `protocol.json`), so a backend
rename of the CSRF header changes `schemas_sha256` exactly as a schema edit would. The pin is:

```json
{
  "backend_repo":   "Prakash2571/GTSAlgoResearch_B",
  "backend_sha":    "<the backend commit that introduces this contract>",
  "contract_version":"<from version.json>",
  "schemas_sha256": "<from version.json>"
}
```

The frontend **pins a COMMIT SHA + a DIGEST**, so a normal frontend build **never depends on
an unpinned, mutable fetch of the backend's `main`**. `npm run contract:verify` recomputes
the digest over the vendored `schemas/**` with the vendored `digest.mjs` and asserts it
equals `schemas_sha256` in **both** `version.json` **and** `BACKEND_CONTRACT.json`; a stale
or tampered vendored contract fails loudly, and a missing file fails loudly.

## How the frontend uses it

- `npm run contract:verify` — digest + presence gate over the vendored files.
- `npm run contract:types` — regenerates `src/api/contract.generated.ts` from the vendored
  schemas **and** emits the `protocol.json` constants (`CSRF_HEADER`, `SESSION_COOKIE_DEFAULT`,
  `CSRF_COOKIE_SUFFIX`) as `export const`s (deterministic; committed). CI regenerates and diffs —
  any difference fails. `src/api/http.ts` **imports `CSRF_HEADER`** from this generated module
  instead of hardcoding `"x-csrf-token"`: the file is bundled for the browser and must not read
  the filesystem at runtime, so a build-time constant is the mechanical single-source. A backend
  rename of `csrf_header` changes `protocol.json` (and the digest), regenerates the constant, and
  fails the committed-file diff and `tests/csrfHeaderContract.test.mjs` until the frontend
  re-vendors.
- `src/api/contract.assert.ts` — compile-time (`tsc -b`) mutual-assignability assertions
  between the hand-written `src/api/types.ts` and the generated contract types. A backend
  shape change the frontend has not adopted makes the build fail.
- `tests/apiContract.test.mjs` / `tests/contractSchemas.test.mjs` — validate the retained
  captured fixtures against the vendored schemas with the vendored `validate.mjs`. The
  **schemas are now the authority**; the fixtures are retained only as realistic samples.

## The coordinated cross-repo update procedure (FOLLOW EXACTLY)

When you change an API response shape, do this **in order**:

1. **Change the backend serializer / route** in `GTSAlgoResearch_B`.
2. **Update the schema** — edit the matching `contract/schemas/*.schema.json`.
3. **Bump `contract_version`** in `contract/version.json` (semver).
4. **Regenerate `schemas_sha256`** — `node contract/digest.mjs`, paste into `version.json`.
5. **Run the backend contract tests** (`npm run test:contract` in `GTSAlgoResearch_B`).
6. **Copy `contract/` into the frontend and update the pin.** In `GTSAlgoResearch_F`, replace this
   vendored directory and update `BACKEND_CONTRACT.json` with the **backend commit SHA** and
   the new **`schemas_sha256`**. Then run `npm run contract:types` and commit the regenerated
   `src/api/contract.generated.ts`.
7. **Run the frontend gate** — `npm run contract:verify`, `npm run build` (static
   assignability), `npm test`. Fix the frontend types until green.
8. **Merge order: backend FIRST, then frontend.** Merging the frontend first would point it
   at a shape the deployed backend does not yet emit — and would leave `backend_sha` pinning
   a commit that does not contain the contract (see the banner at the top of this file).

## Schema inventory

Access: `access-verify`, `access-status`.
Runtime/export: `runtime-status` (+ `broker-runtime-status`), `export-status`.
Broker: `broker-status` (+ `broker-session`, `broker-health`), `broker-switch-blockers`,
`broker-select-success`, `broker-select-refusal`.
Box: `box-status`, `box-config`, `box-execution-control` (+ `arm-verdict`),
`box-opportunities` (+ `box-opportunity`, `box-leg-evaluation`), `box-chains`
(+ `box-chain-quote`), `box-open-trades` (+ `box-open-position`), `box-trades-history`
(+ `box-trade`, `box-trade-leg`), `box-execution-attempts`, `box-events` (+ `box-event-leg`),
`box-sse-snapshot`, `sse-envelope`, `margin-provenance`.

The validator is a **dependency-free** JSON-Schema (draft 2020-12 subset) validator; an
unsupported keyword is a LOUD error, never a silent pass. See `validate.mjs` for the exact
supported subset.
