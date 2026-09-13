/**
 * THE PASSCODE DIALOG AND THE LANDING COPY.
 *
 * No DOM library is available in this project (the whole suite runs under plain `node:test`),
 * so the dialog's rendered behaviour cannot be driven here. What CAN be pinned — and what
 * actually regresses in practice — is the contract of its source:
 *
 *   • the required copy, verbatim, because it is specified;
 *   • that the passcode is never written to any client-side store;
 *   • that a double submit is blocked SYNCHRONOUSLY (a `disabled` prop alone does not stop two
 *     Enter keypresses in the same frame — both read the same stale render closure);
 *   • that the input is focused and the field is a real password input;
 *   • that Escape-to-close and focus management come from the shared dialog primitive rather
 *     than being re-implemented (and forgotten) here;
 *   • that the rejection message is the single fixed string and leaks nothing.
 *
 * The behaviour of the underlying API calls IS tested for real, in accessGate.test.mjs and
 * csrfToken.test.mjs.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, resolve } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
const SRC = resolve(HERE, "..", "src");

const read = (...parts) => readFileSync(join(SRC, ...parts), "utf8");

/**
 * Strip comments.
 *
 * Essential for the "must NOT contain X" assertions below. These files DOCUMENT, at length,
 * that they never touch localStorage, never mention the database and make no performance
 * claims — so scanning the raw text for those words would fail on the very comments that
 * explain the rule. Only executable code and rendered strings are scanned.
 */
function code(text) {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}

const MODAL = read("auth", "PasscodeModal.tsx");
const DIALOG = read("components", "ui", "Modal.tsx");
const LANDING = read("pages", "LandingPage.tsx");
const HEADER = read("components", "layout", "LandingHeader.tsx");
const FOOTER = read("components", "layout", "LandingFooter.tsx");
const PROVIDER = read("auth", "AccessGate.tsx");

const MODAL_CODE = code(MODAL);
const LANDING_CODE = code(LANDING);
const PROVIDER_CODE = code(PROVIDER);

/* ---------------------------------- the dialog ---------------------------------- */

test("the dialog carries the specified copy", () => {
  assert.match(MODAL, /title="Enter GTS Box"/);
  assert.match(MODAL, /subtitle="Private algorithmic trading workspace"/);
  assert.match(MODAL, />\s*Passcode\s*</, "the field is labelled Passcode");
  assert.match(MODAL, />\s*Cancel\s*</, "the secondary action is Cancel");
  // The primary button swaps its label while verifying, so both strings live in one ternary.
  assert.match(
    MODAL,
    /\{submitting \? "Verifying…" : "Continue"\}/,
    "the primary action reads Continue, and Verifying… while in flight",
  );
  assert.match(MODAL, /"Invalid passcode"/, "the rejection is exactly 'Invalid passcode'");
});

test("the rejection message reveals nothing about the deployment", () => {
  // No mention of the secret's name or existence, of attempt counts, or of server internals.
  for (const forbidden of [
    /SITE_ACCESS_SECRET/,
    /attempts? remaining/i,
    /\bnot configured\b/i,
    /postgres|database|sql/i,
  ]) {
    assert.doesNotMatch(MODAL_CODE, forbidden, `the dialog must not surface ${forbidden}`);
  }
});

test("the passcode is never persisted client-side", () => {
  for (const store of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/]) {
    assert.doesNotMatch(MODAL_CODE, store, `the passcode dialog must not touch ${store}`);
  }
  // And it is cleared as soon as it is no longer needed.
  assert.match(MODAL, /setPasscode\(""\)/, "the passcode is cleared on success");
});

test("the field is a real password input, focused, with spellcheck off", () => {
  assert.match(MODAL, /type="password"/);
  assert.match(MODAL, /autoComplete="current-password"/);
  assert.match(MODAL, /autoFocus/, "the input is focused so no mouse is needed");
  assert.match(MODAL, /spellCheck=\{false\}/);
  // A real label bound to the input, not a placeholder standing in for one.
  assert.match(MODAL, /htmlFor="gts-passcode"/);
  assert.match(MODAL, /id="gts-passcode"/);
});

test("submission is a real form, so Enter submits", () => {
  assert.match(MODAL, /<form[\s\S]*onSubmit=/, "a real form gives Enter-to-submit for free");
  assert.match(MODAL, /type="submit"/, "the primary button submits the form");
});

test("a double submit is blocked SYNCHRONOUSLY, not only by the disabled prop", () => {
  // `disabled={submitting}` is not enough: two Enter keypresses in the same frame both read
  // `submitting === false` from their own render closure and both fire. A ref claimed before
  // any await is what actually stops the second one.
  assert.match(MODAL, /inFlight\s*=\s*useRef\(false\)/, "a ref-held in-flight guard exists");
  assert.match(MODAL, /if \(inFlight\.current\) return;/, "the second submit returns early");
  assert.match(MODAL, /inFlight\.current = true;/);
  assert.match(MODAL, /inFlight\.current = false;/, "the guard is released in a finally");
  // The disabled prop is still there as the visible affordance.
  assert.match(MODAL, /disabled=\{submitting/);
});

test("the dialog cannot be dismissed mid-verify", () => {
  // Closing while the request is in flight would leave the session established with the
  // browser still on the public page.
  assert.match(MODAL, /dismissible=\{!submitting\}/);
});

test("Escape, focus movement and the focus trap come from the shared dialog primitive", () => {
  // Not re-implemented in the passcode dialog — one implementation, one place to get right.
  assert.match(MODAL, /from "\.\.\/components\/ui\/Modal\.tsx"/);
  assert.match(DIALOG, /event\.key === "Escape"/, "Escape closes");
  assert.match(DIALOG, /event\.key !== "Tab"/, "Tab is trapped inside the dialog");
  assert.match(DIALOG, /role="dialog"/);
  assert.match(DIALOG, /aria-modal="true"/);
  assert.match(DIALOG, /aria-labelledby=/, "the dialog is named by its title");
  assert.match(DIALOG, /openerRef/, "focus is restored to the element that opened it");
  assert.match(DIALOG, /document\.body\.style\.overflow/, "background scroll is locked");
});

test("the error is announced, not only shown", () => {
  assert.match(MODAL, /role="alert"/, "the rejection is a live region");
  assert.match(MODAL, /aria-invalid=\{error !== null\}/);
});

/* --------------------------------- the landing --------------------------------- */

test("the hero carries the specified copy", () => {
  assert.match(LANDING, /Algorithmic trading research · Ghatsila/);
  assert.match(LANDING, /Research\. Engineer\. Execute\./);
  assert.match(
    LANDING,
    /GTS Algo Research is an algorithmic trading research project from\s*\n?\s*Ghatsila,\s*\n?\s*developed by the BeOnEdge team\./,
  );
  assert.match(
    LANDING,
    /We build research-driven systems for market structure, execution and systematic\s*\n?\s*trading\./,
  );
  assert.match(LANDING, /Private research workspace/i);
});

test("Enter Box is the single primary call to action", () => {
  assert.match(HEADER, />\s*Enter Box\s*</, "the header CTA");
  assert.match(LANDING, />\s*Enter Box\s*</, "the hero CTA");
  // Both go through the same handler, so there is one way in.
  assert.match(HEADER, /onEnterBox/);
  assert.match(LANDING, /onEnterBox=\{onEnterBox\}/);
});

test("an already-authenticated visitor skips the passcode entirely", () => {
  assert.match(
    LANDING_CODE,
    /if \(authenticated\) \{\s*navigate\(ROUTE_PATHS\.box\);/,
    "Enter Box with a live session navigates straight to the workspace",
  );
});

test("?auth=1 opens the dialog, but never while the session is still unknown", () => {
  assert.match(LANDING, /readQueryParam\(location\.search, "auth"\)/);
  assert.match(
    LANDING_CODE,
    /if \(state === "checking"\) return;/,
    "the dialog must not flash at a visitor who may already have a session",
  );
});

test("the three pillars are present with their specified copy", () => {
  assert.match(LANDING, /label: "Research"/);
  assert.match(LANDING, /Market structure, execution quality and systematic opportunity analysis\./);
  assert.match(LANDING, /label: "Systems"/);
  assert.match(
    LANDING,
    /Real-time market-data pipelines, broker integrations and automated execution infrastructure\./,
  );
  assert.match(LANDING, /label: "Risk"/);
  assert.match(
    LANDING,
    /Explicit controls, deterministic state transitions and defensive execution safeguards\./,
  );
});

test("the footer states identity, place and ownership — and nothing invented", () => {
  assert.match(FOOTER, /GTS Algo Research/);
  assert.match(FOOTER, /Ghatsila · India/);
  assert.match(FOOTER, /A BeOnEdge project/);
  assert.match(FOOTER, /© GTS Algo Research/);
});

test("the public page makes no unsupported claims", () => {
  const publicCopy = code(`${LANDING}\n${HEADER}\n${FOOTER}`);
  for (const claim of [
    /guaranteed returns?/i,
    /risk[- ]free/i,
    /institutional[- ]grade/i,
    /high[- ]frequency/i,
    /\bAI[- ]powered\b/i,
    /profitable strategy/i,
    /beat(ing)? the market/i,
    /assets under management|\bAUM\b/i,
  ]) {
    assert.doesNotMatch(publicCopy, claim, `the public page must not claim ${claim}`);
  }
});

/* --------------------------------- the session --------------------------------- */

test("a 401 anywhere clears authenticated state", () => {
  // This is what unmounts the workspace (tearing down its SSE stream and timers via the
  // component's own effect cleanup) and returns the browser to the public page.
  assert.match(PROVIDER_CODE, /onUnauthorized\(\(\) => \{[\s\S]*?setState\("anonymous"\)/);
  assert.match(PROVIDER_CODE, /clearCsrfToken\(\)/, "the stale CSRF token is dropped too");
});

test("the session state fails CLOSED when the status probe fails", () => {
  // Every failure path — including a 401 — must resolve to "anonymous". Treating an
  // unreachable backend as authenticated would mount the workspace on no evidence.
  const anonymousOnFailure = [
    ...PROVIDER_CODE.matchAll(/catch \{[\s\S]{0,160}?setState\("anonymous"\)/g),
  ];
  assert.ok(
    anonymousOnFailure.length >= 2,
    "both the mount probe and refresh() must fall back to anonymous on any error",
  );
  assert.doesNotMatch(
    PROVIDER_CODE,
    /catch \{[\s\S]{0,160}?setState\("authenticated"\)/,
    "no error path may ever grant access",
  );
});

test("the provider stores no session token client-side", () => {
  for (const store of [/localStorage/, /sessionStorage/, /indexedDB/, /document\.cookie/]) {
    assert.doesNotMatch(PROVIDER_CODE, store, `the session provider must not touch ${store}`);
  }
});
