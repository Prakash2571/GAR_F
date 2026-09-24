/**
 * A REAL DOM HARNESS: jsdom + React + esbuild-transformed TSX.
 *
 * WHY THIS EXISTS
 *
 * This repo had no DOM testing of any kind. Its 31 suites were either direct imports of pure `.ts`
 * modules or `readFileSync` regex assertions over `.tsx` source text. Source-text assertions are how
 * the cancellation defect survived: you can assert that a file CONTAINS a cancel button and still ship
 * one that never renders, because the button was nested inside a conditional. Only rendering the
 * component and looking for the button proves the operator can reach it.
 *
 * `node --experimental-strip-types` strips TYPES but does not transform JSX, so `.tsx` cannot be
 * imported by the existing runner at all. This harness closes that with two pieces:
 *
 *   1. `loadComponent()` — esbuild (already present as a Vite dependency) transforms a `.tsx` entry and
 *      its local imports into one ESM bundle, which is then imported from a data: URL. React and
 *      react-dom stay EXTERNAL so the test and the component share one React instance; anything else
 *      the component imports is bundled, so its real dependencies are exercised rather than mocked.
 *   2. `mountDom()` — installs a jsdom window as the globals React DOM expects, and returns helpers for
 *      querying and clicking.
 *
 * WHAT IS DELIBERATELY NOT MOCKED. The component under test, every module it imports from `src/`, and
 * React's own reconciliation and event dispatch. What IS stubbed is the network (`globalThis.fetch`, the
 * same seam `csrfToken.test.mjs` already uses) and `window.confirm`, because a real dialog cannot be
 * answered from a test.
 *
 * jsdom is not a browser, and this file does not pretend it is: there is no layout, so it cannot prove
 * a control is VISUALLY visible. It proves the control is RENDERED, ENABLED and that clicking it calls
 * what it should — which is exactly what the defects here were about.
 */

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { JSDOM } from "jsdom";
import * as esbuild from "esbuild";

const HERE = dirname(fileURLToPath(import.meta.url));
export const SRC = resolve(HERE, "..", "..", "src");
/** Inside node_modules so it is already git-ignored and so `react` resolves from there. */
const BUILD_DIR = resolve(HERE, "..", "..", "node_modules", ".gar-dom-tests");

/**
 * Bundle a `.tsx` entry point and import it.
 *
 * The bundle is written to a real file under `node_modules/.gar-dom-tests/` rather than imported from a
 * `data:` URL, because a data URL has no hierarchical base and therefore cannot resolve the bare
 * specifier `react` — and React MUST stay external so the test and the component share one React
 * instance (two copies each keep their own hook dispatcher, which throws "invalid hook call").
 *
 * `define` is used rather than a Vite config because the component tree reads `import.meta.env`
 * indirectly through `src/api/http.ts`'s origin resolution.
 */
export async function loadComponent(relativeEntry) {
  const entry = resolve(SRC, relativeEntry);
  const built = await esbuild.build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    loader: { ".css": "empty", ".jpg": "empty", ".png": "empty", ".svg": "empty" },
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    logLevel: "silent",
  });
  const code = built.outputFiles[0].text;
  mkdirSync(BUILD_DIR, { recursive: true });
  const out = resolve(
    BUILD_DIR,
    `${relativeEntry.replace(/[^a-zA-Z0-9]/g, "_")}-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`,
  );
  writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

/**
 * Bundle a SYNTHETIC entry that re-exports from several `src/` modules, so they share ONE module graph.
 *
 * Needed because two separate `loadComponent` calls produce two bundles and therefore two module
 * instances. `src/api/http.ts` keeps the CSRF token in a module-level variable and throws
 * `MissingCsrfTokenError` before the network for any mutating call without one — a real safety property
 * the test must satisfy rather than bypass. Setting it on a different instance would leave every click
 * refused locally, so the setter has to come from the instance the component actually holds.
 *
 * `exports` is a map of local name -> `{ from, name }`.
 */
export async function loadBundle(exports) {
  const lines = Object.entries(exports).map(([local, spec]) =>
    `export { ${spec.name}${spec.name === local ? "" : ` as ${local}`} } from "./${spec.from}";`,
  );
  const built = await esbuild.build({
    stdin: { contents: lines.join("\n"), resolveDir: SRC, sourcefile: "gar-test-entry.ts", loader: "ts" },
    bundle: true,
    write: false,
    format: "esm",
    platform: "browser",
    target: "es2022",
    jsx: "automatic",
    external: ["react", "react-dom", "react-dom/client", "react/jsx-runtime"],
    loader: { ".css": "empty", ".jpg": "empty", ".png": "empty", ".svg": "empty" },
    define: { "import.meta.env.DEV": "false", "import.meta.env.PROD": "true" },
    logLevel: "silent",
  });
  const code = built.outputFiles[0].text;
  mkdirSync(BUILD_DIR, { recursive: true });
  const out = resolve(
    BUILD_DIR,
    `bundle-${createHash("sha256").update(code).digest("hex").slice(0, 12)}.mjs`,
  );
  writeFileSync(out, code);
  return import(pathToFileURL(out).href);
}

/** The source text of a file under src/, for the few assertions that are genuinely about source. */
export function sourceOf(relativePath) {
  return readFileSync(resolve(SRC, relativePath), "utf8");
}

/**
 * Install a jsdom window and return a mount/query/click toolkit.
 *
 * `teardown()` must be called (use `t.after`), or the globals leak into the next test file and React
 * warns about multiple roots.
 */
export function mountDom({ url = "https://example.test/box" } = {}) {
  const dom = new JSDOM("<!doctype html><html><body><div id=\"root\"></div></body></html>", {
    url,
    pretendToBeVisual: true,
  });
  const { window } = dom;

  const saved = {};
  /**
   * Install a global, remembering what was there.
   *
   * `Object.defineProperty` rather than assignment because Node 22 defines some of these — `navigator`
   * most notably — as getter-only on `globalThis`, so a plain assignment throws.
   */
  const install = (key, value) => {
    saved[key] = {
      had: key in globalThis,
      descriptor: Object.getOwnPropertyDescriptor(globalThis, key),
    };
    Object.defineProperty(globalThis, key, {
      value,
      configurable: true,
      writable: true,
      enumerable: false,
    });
  };
  // The globals react-dom reads. `navigator` and `location` are needed by the origin resolver.
  install("window", window);
  install("document", window.document);
  install("navigator", window.navigator);
  install("location", window.location);
  install("HTMLElement", window.HTMLElement);
  install("Element", window.Element);
  install("Node", window.Node);
  install("Event", window.Event);
  install("MouseEvent", window.MouseEvent);
  install("CustomEvent", window.CustomEvent);
  install("getComputedStyle", window.getComputedStyle.bind(window));
  install("requestAnimationFrame", (cb) => setTimeout(() => cb(Date.now()), 0));
  install("cancelAnimationFrame", (id) => clearTimeout(id));
  // React 18 checks this to decide whether it is in a test environment.
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;

  const container = window.document.getElementById("root");

  return {
    window,
    document: window.document,
    container,

    /** Every text node's content, whitespace-collapsed. For asserting operator-visible copy. */
    text: () => container.textContent.replace(/\s+/g, " ").trim(),

    /** All rendered buttons, as `{ label, disabled, title, el }`. */
    buttons: () =>
      [...container.querySelectorAll("button")].map((el) => ({
        label: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        disabled: el.disabled === true,
        title: el.getAttribute("title") ?? "",
        el,
      })),

    /** The first button whose label matches, or undefined. */
    button: (matcher) =>
      [...container.querySelectorAll("button")]
        .map((el) => ({
          label: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
          disabled: el.disabled === true,
          title: el.getAttribute("title") ?? "",
          el,
        }))
        .find((b) => (typeof matcher === "string" ? b.label.includes(matcher) : matcher.test(b.label))),

    /** Elements matching a CSS selector, with collapsed text. */
    all: (selector) =>
      [...container.querySelectorAll(selector)].map((el) => ({
        el,
        text: (el.textContent ?? "").replace(/\s+/g, " ").trim(),
        className: el.className,
      })),

    teardown() {
      for (const [key, prev] of Object.entries(saved)) {
        if (prev.had && prev.descriptor) Object.defineProperty(globalThis, key, prev.descriptor);
        else delete globalThis[key];
      }
      delete globalThis.IS_REACT_ACT_ENVIRONMENT;
      window.close();
    },
  };
}

/**
 * Render `element` into `dom.container` and flush React's work.
 *
 * `act` is imported from `react-dom/test-utils` via `react`'s own export so there is exactly one React.
 */
export async function render(dom, element) {
  const { createRoot } = await import("react-dom/client");
  const React = await import("react");
  const act = React.act ?? (await import("react-dom/test-utils")).act;
  let root;
  await act(async () => {
    root = createRoot(dom.container);
    root.render(element);
  });
  return {
    root,
    async update(next) {
      await act(async () => { root.render(next); });
    },
    async unmount() {
      await act(async () => { root.unmount(); });
    },
  };
}

/** Click a real DOM element through React's event system and flush the resulting work. */
export async function click(el) {
  const React = await import("react");
  const act = React.act ?? (await import("react-dom/test-utils")).act;
  await act(async () => {
    el.dispatchEvent(new globalThis.window.MouseEvent("click", { bubbles: true, cancelable: true }));
  });
}

/** Let queued microtasks and timers drain, so a settled fetch has reached React state. */
export async function flush(ms = 0) {
  const React = await import("react");
  const act = React.act ?? (await import("react-dom/test-utils")).act;
  await act(async () => {
    await new Promise((r) => setTimeout(r, ms));
  });
}

/**
 * Replace `globalThis.fetch` with a router, and record every call.
 *
 * Same seam the existing `csrfToken.test.mjs` / `csrfHeaderContract.test.mjs` suites use. A route may
 * return a response, throw, or return a promise that never settles — which is how the stalled-request
 * cases are driven.
 */
export function stubFetch(routes) {
  const calls = [];
  const previous = globalThis.fetch;
  globalThis.fetch = async (input, init = {}) => {
    const url = typeof input === "string" ? input : String(input?.url ?? input);
    calls.push({ url, method: init.method ?? "GET", init });
    for (const [pattern, handler] of Object.entries(routes)) {
      if (url.includes(pattern)) return handler({ url, init, calls });
    }
    throw new Error(`unstubbed fetch: ${init.method ?? "GET"} ${url}`);
  };
  return {
    calls,
    restore() {
      if (previous === undefined) delete globalThis.fetch;
      else globalThis.fetch = previous;
    },
  };
}

/** A JSON Response, as the real API returns. */
export function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A fetch that never settles, for the stalled-request cases. Resolve/reject it from the test. */
export function stalledResponse() {
  let settle = () => {};
  let fail = () => {};
  const promise = new Promise((res, rej) => { settle = res; fail = rej; });
  return { promise, settle, fail };
}
