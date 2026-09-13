/**
 * THEME: persistence, fallback, and what "apply" actually does.
 *
 * Dark and light are both first-class in the redesign, so the switch is worth pinning:
 *
 *   • a stored preference SURVIVES a reload (that is what "persists" means here — the value
 *     is read back out of storage on the next read, not held in component state);
 *   • only the two exact strings are honoured, so a corrupt or foreign value cannot pin the
 *     page to a theme nobody chose;
 *   • with nothing stored, the OS preference decides, and dark is the fallback;
 *   • storage that THROWS (private mode, disabled cookies) must not break the app;
 *   • applyTheme sets all three hooks the stylesheet and the browser chrome depend on, for
 *     BOTH themes — `data-theme` (which every CSS token hangs off), `color-scheme` (so
 *     scrollbars, form controls and the caret follow the theme) and the `theme-color` meta.
 */

import test from "node:test";
import assert from "node:assert/strict";

import {
  THEME_STORAGE_KEY,
  THEME_COLOR,
  DEFAULT_THEME,
  parseStoredTheme,
  readStoredTheme,
  storeTheme,
  applyTheme,
} from "../src/lib/theme.ts";

/** A localStorage stand-in. `throws` simulates private mode / disabled storage. */
function installStorage({ initial = {}, throws = false } = {}) {
  const store = new Map(Object.entries(initial));
  globalThis.localStorage = {
    getItem: (k) => {
      if (throws) throw new Error("storage is unavailable");
      return store.has(k) ? store.get(k) : null;
    },
    setItem: (k, v) => {
      if (throws) throw new Error("storage is unavailable");
      store.set(k, String(v));
    },
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  return store;
}

/** A window stand-in exposing only matchMedia. `undefined` simulates no matchMedia at all. */
function installMatchMedia(prefersLight) {
  globalThis.window =
    prefersLight === undefined
      ? {}
      : { matchMedia: (query) => ({ matches: prefersLight && query.includes("light") }) };
}

/** A minimal document stand-in that records what applyTheme wrote. */
function installDocument({ withMeta = true } = {}) {
  const meta = { content: null, setAttribute: (k, v) => { meta[k] = v; meta.content = v; } };
  const html = { dataset: {}, style: {} };
  globalThis.document = {
    documentElement: html,
    querySelector: (sel) => (withMeta && sel.includes("theme-color") ? meta : null),
  };
  return { html, meta };
}

test("the storage key is the rebranded UI-preference key", () => {
  // One of only two localStorage keys the app is allowed to write; CI enforces that
  // allow-list against the built bundle, so this key and that list must agree.
  assert.equal(THEME_STORAGE_KEY, "gts_theme");
});

test("dark is the default identity", () => {
  assert.equal(DEFAULT_THEME, "dark");
});

test("only the two exact theme strings are honoured", () => {
  assert.equal(parseStoredTheme("dark"), "dark");
  assert.equal(parseStoredTheme("light"), "light");
  for (const junk of [null, undefined, "", "Dark", "LIGHT", "system", "dar", "1", "{}"]) {
    assert.equal(parseStoredTheme(junk), null, `${JSON.stringify(junk)} is not a theme`);
  }
});

test("PERSISTENCE: a stored preference is read back on the next load", () => {
  const store = installStorage();
  installMatchMedia(false);
  installDocument();

  storeTheme("light");
  assert.equal(store.get(THEME_STORAGE_KEY), "light", "the choice was written to storage");
  // A fresh read — the equivalent of a page reload, where no component state survives.
  assert.equal(readStoredTheme(), "light", "the stored theme survives a reload");

  storeTheme("dark");
  assert.equal(readStoredTheme(), "dark", "switching back also persists");
});

test("a stored preference BEATS the OS preference", () => {
  installStorage({ initial: { [THEME_STORAGE_KEY]: "dark" } });
  installMatchMedia(true); // OS says light
  assert.equal(readStoredTheme(), "dark", "an explicit choice is not overridden by the OS");
});

test("with nothing stored, the OS preference decides", () => {
  installStorage();
  installMatchMedia(true);
  assert.equal(readStoredTheme(), "light");

  installStorage();
  installMatchMedia(false);
  assert.equal(readStoredTheme(), "dark");
});

test("a corrupt stored value falls through to the OS preference, not to junk", () => {
  installStorage({ initial: { [THEME_STORAGE_KEY]: "chartreuse" } });
  installMatchMedia(true);
  assert.equal(readStoredTheme(), "light");
});

test("storage that THROWS does not break theme selection", () => {
  installStorage({ throws: true });
  installMatchMedia(true);
  // Falls through to the OS preference rather than propagating the error.
  assert.equal(readStoredTheme(), "light");
  // And writing must not throw either — the theme still applies, it is just not remembered.
  assert.doesNotThrow(() => storeTheme("dark"));
});

test("no matchMedia and no stored value falls back to dark", () => {
  installStorage({ throws: true });
  installMatchMedia(undefined);
  assert.equal(readStoredTheme(), DEFAULT_THEME);
});

test("applyTheme sets all three rendering hooks — for dark", () => {
  const { html, meta } = installDocument();
  applyTheme("dark");
  // The switch every CSS token hangs off.
  assert.equal(html.dataset.theme, "dark");
  // Makes native controls, scrollbars and the caret follow the theme.
  assert.equal(html.style.colorScheme, "dark");
  // Browser chrome.
  assert.equal(meta.content, THEME_COLOR.dark);
});

test("applyTheme sets all three rendering hooks — for light", () => {
  const { html, meta } = installDocument();
  applyTheme("light");
  assert.equal(html.dataset.theme, "light");
  assert.equal(html.style.colorScheme, "light");
  assert.equal(meta.content, THEME_COLOR.light);
});

test("the two themes are genuinely different colours, and dark is the darker one", () => {
  assert.notEqual(THEME_COLOR.dark, THEME_COLOR.light);
  const luminance = (hex) =>
    [1, 3, 5].reduce((sum, i) => sum + parseInt(hex.slice(i, i + 2), 16), 0);
  assert.ok(
    luminance(THEME_COLOR.dark) < luminance(THEME_COLOR.light),
    "light mode is a real light palette, not an inverted dark one",
  );
});

test("applyTheme tolerates a document with no theme-color meta", () => {
  const { html } = installDocument({ withMeta: false });
  assert.doesNotThrow(() => applyTheme("light"));
  assert.equal(html.dataset.theme, "light", "the theme still applies without the meta tag");
});
