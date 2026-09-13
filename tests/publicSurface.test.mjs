/**
 * THE PUBLIC PAGE MUST NOT REACH THE TRADING BACKEND.
 *
 * The landing page at "/" is served to anyone. It must not load — or be ABLE to load — any
 * account-shaped or trading-shaped data: no Box SSE stream, no broker status, no positions, no
 * trade history, no execution or readiness polling. That is a security boundary (nothing about
 * the account is fetched for an anonymous visitor) and a resource decision (a public page must
 * not hold an SSE connection open against a trading backend).
 *
 * A comment cannot enforce that, and a rendering test cannot run here (no DOM library is
 * available). So this suite walks the REAL transitive import graph of the landing route from
 * source and asserts that the trading API modules are unreachable from it. If someone later
 * adds a "live stats" widget to the landing page, the import appears in the graph and this
 * fails — which is the point.
 *
 * The same walker then proves the workspace DOES reach those modules, so the test cannot pass
 * vacuously by failing to resolve imports at all.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve, relative } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

/** Resolve a relative import specifier to a file on disk, or null for a bare package. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith(".")) return null; // a node_modules package — not part of our graph
  const base = resolve(dirname(fromFile), spec);
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate) && !candidate.endsWith("/")) {
      try {
        if (readFileSync(candidate)) return candidate;
      } catch {
        /* a directory — keep looking */
      }
    }
  }
  return null;
}

/** Every module reachable from `entry`, as repo-relative paths. */
function importGraph(entry) {
  const seen = new Set();
  const queue = [resolve(SRC, entry)];
  while (queue.length > 0) {
    const file = queue.pop();
    const key = relative(SRC, file);
    if (seen.has(key)) continue;
    seen.add(key);
    let text;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    // `import … from "x"`, `export … from "x"` and bare `import "x"`.
    for (const m of text.matchAll(/(?:^|\n)\s*(?:import|export)[^;\n]*?from\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, m[1]);
      if (next) queue.push(next);
    }
    for (const m of text.matchAll(/(?:^|\n)\s*import\s*["']([^"']+)["']/g)) {
      const next = resolveImport(file, m[1]);
      if (next) queue.push(next);
    }
  }
  return seen;
}

/**
 * The modules that talk to the trading backend. `api.ts` is the barrel that re-exports
 * `api/box.ts`, so both are named — importing either pulls in the whole Box surface.
 */
const TRADING_API_MODULES = ["api/box.ts", "api.ts"];

/** The protected workspace components. None of these may be reachable from the public page. */
const WORKSPACE_MODULES = [
  "Box.tsx",
  "BrokerStatusPanel.tsx",
  "BoxExecutionControl.tsx",
  "BoxSessionControl.tsx",
  "BoxRiskControl.tsx",
  "BoxOperationalState.tsx",
  "BoxOrderStreamStatus.tsx",
  "lib/boxStream.ts",
];

test("the landing route's import graph resolves (the walker is not vacuous)", () => {
  const graph = importGraph("pages/LandingPage.tsx");
  assert.ok(graph.has("pages/LandingPage.tsx"));
  // Proof the walker actually follows edges: these are genuine transitive dependencies.
  assert.ok(graph.has("auth/PasscodeModal.tsx"), "landing → passcode dialog");
  assert.ok(graph.has("auth/AccessGate.tsx"), "landing → session provider");
  assert.ok(graph.has("api/access.ts"), "landing → the access API (allowed: it is not trading data)");
  assert.ok(graph.size > 8, `expected a real graph, got ${graph.size} modules`);
});

test("the landing page CANNOT reach the trading API", () => {
  const graph = importGraph("pages/LandingPage.tsx");
  for (const mod of TRADING_API_MODULES) {
    assert.equal(
      graph.has(mod),
      false,
      `the public landing page must not import ${mod} — no trading or account data may be ` +
        `fetched for an anonymous visitor`,
    );
  }
});

test("the landing page CANNOT reach any workspace component or the Box SSE stream", () => {
  const graph = importGraph("pages/LandingPage.tsx");
  for (const mod of WORKSPACE_MODULES) {
    assert.equal(
      graph.has(mod),
      false,
      `the public landing page must not import ${mod} — the workspace and its streams mount ` +
        `only behind the auth guard`,
    );
  }
});

test("the WORKSPACE does reach the trading API (so the assertions above mean something)", () => {
  const graph = importGraph("pages/BoxPage.tsx");
  assert.ok(graph.has("Box.tsx"), "the protected page renders the Box workspace");
  assert.ok(
    TRADING_API_MODULES.some((m) => graph.has(m)),
    "the workspace reaches the trading API — proving the public-page assertions are not vacuous",
  );
  assert.ok(graph.has("lib/boxStream.ts"), "the workspace owns the SSE stream");
});

test("only the protected route is wrapped in the auth guard", () => {
  // Comments stripped: the file's own header documents the route table using the literal
  // `<ProtectedRoute>`, which would otherwise be matched instead of the real JSX.
  const routes = readFileSync(join(SRC, "app", "routes.tsx"), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/(^|\s)\/\/.*$/gm, "$1");

  // The guard wraps BoxPage, and BoxPage is the ONLY thing inside it.
  const guarded = routes.match(/<ProtectedRoute>([\s\S]*?)<\/ProtectedRoute>/);
  assert.ok(guarded, "the workspace must be rendered inside <ProtectedRoute>");
  assert.match(guarded[1], /^\s*<BoxPage\s*\/>\s*$/, "only the workspace is behind the guard");

  // Exactly one guard, so a second one cannot appear around the public page unnoticed.
  assert.equal(
    [...routes.matchAll(/<ProtectedRoute>/g)].length,
    1,
    "there is exactly one auth guard in the route table",
  );

  // The landing page is returned UNWRAPPED.
  assert.match(
    routes,
    /return <LandingPage \/>;/,
    "the landing page must be returned directly — it is the public surface, never behind the guard",
  );
});

test("ProtectedRoute renders its children ONLY in the authenticated state", () => {
  const src = readFileSync(join(SRC, "auth", "ProtectedRoute.tsx"), "utf8");
  // Children are returned from exactly one place, guarded on the authenticated state. This is
  // what guarantees there is no frame in which protected content is on screen before the
  // backend has confirmed the session.
  assert.match(
    src,
    /if\s*\(state === "authenticated"\)\s*return\s*<>\{children\}<\/>;/,
    "children must be gated on state === 'authenticated'",
  );
  const childrenRenders = [...src.matchAll(/\{children\}/g)];
  assert.equal(
    childrenRenders.length,
    1,
    "children must be rendered from exactly ONE guarded place, so no branch can leak them",
  );
  // The non-authenticated branch must not render a workspace skeleton, which would imply to an
  // unauthenticated visitor that the workspace is loading.
  assert.match(src, /gts-route-wait/, "the waiting surface is the neutral one");
});
