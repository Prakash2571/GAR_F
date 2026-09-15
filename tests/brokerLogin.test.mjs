/**
 * The in-app broker sign-in return path.
 *
 * A full page load separates "click Connect" from "you are connected", so the query string
 * the backend redirects back with is the ONLY channel carrying the outcome. These tests pin
 * that contract from the frontend side: the parameter names, what counts as a recognised
 * outcome, that nothing unrecognised is turned into a scary notice, and that the parameters
 * are removed afterwards without destroying unrelated query state.
 *
 * Pure module, no DOM — which is why the parsing lives in `src/lib/brokerLogin.ts` rather
 * than inline in a component (this repo has no jsdom/RTL harness, so logic that matters has
 * to be extractable to be testable at all).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  BROKER_LOGIN_PARAM,
  BROKER_LOGIN_REASON_PARAM,
  BROKER_LOGIN_STATUS_PARAM,
  brokerLabel,
  describeBrokerLoginFailure,
  describeBrokerLoginOutcome,
  readBrokerLoginOutcome,
  stripBrokerLoginParams,
} from "../src/lib/brokerLogin.ts";

test("the redirect parameter names are the ones the backend sends", () => {
  // These three strings ARE the cross-repo contract for the return leg. If the backend's
  // loginResultRedirect() is renamed, this is the frontend-side tripwire.
  assert.equal(BROKER_LOGIN_PARAM, "broker_login");
  assert.equal(BROKER_LOGIN_STATUS_PARAM, "status");
  assert.equal(BROKER_LOGIN_REASON_PARAM, "reason");
});

test("a successful sign-in is read for either broker", () => {
  assert.deepEqual(readBrokerLoginOutcome("?broker_login=zerodha&status=connected"), {
    broker: "zerodha",
    status: "connected",
    reason: null,
  });
  assert.deepEqual(readBrokerLoginOutcome("broker_login=dhan&status=connected"), {
    broker: "dhan",
    status: "connected",
    reason: null,
  });
});

test("a failed sign-in carries its reason code", () => {
  assert.deepEqual(readBrokerLoginOutcome("?broker_login=dhan&status=failed&reason=login_expired"), {
    broker: "dhan",
    status: "failed",
    reason: "login_expired",
  });
});

test("a reason on a SUCCESS is ignored, so a hand-edited URL cannot fake an error", () => {
  const outcome = readBrokerLoginOutcome("?broker_login=zerodha&status=connected&reason=exchange_failed");
  assert.equal(outcome.status, "connected");
  assert.equal(outcome.reason, null);
});

test("anything unrecognised is NOT a sign-in outcome, so a plain reload announces nothing", () => {
  // The distinction that matters: absent/partial/unknown must be null, never a synthesised
  // failure, or every reload of /box would alarm the operator.
  assert.equal(readBrokerLoginOutcome(""), null);
  assert.equal(readBrokerLoginOutcome("?"), null);
  assert.equal(readBrokerLoginOutcome("?foo=bar"), null);
  assert.equal(readBrokerLoginOutcome("?broker_login=zerodha"), null, "a missing status is not an outcome");
  assert.equal(readBrokerLoginOutcome("?status=connected"), null, "a missing broker is not an outcome");
  assert.equal(readBrokerLoginOutcome("?broker_login=kotak&status=connected"), null, "an unknown broker is refused");
  assert.equal(readBrokerLoginOutcome("?broker_login=zerodha&status=weird"), null, "an unknown status is refused");
});

test("the sign-in parameters are stripped, and unrelated query state survives", () => {
  assert.equal(stripBrokerLoginParams("?broker_login=zerodha&status=connected"), "");
  assert.equal(stripBrokerLoginParams("?broker_login=dhan&status=failed&reason=not_ready"), "");
  // An unrelated parameter must NOT be collateral damage.
  assert.equal(
    stripBrokerLoginParams("?broker_login=dhan&status=connected&keep=1"),
    "?keep=1",
  );
  assert.equal(stripBrokerLoginParams("?a=1&broker_login=dhan&b=2&status=failed"), "?a=1&b=2");
  assert.equal(stripBrokerLoginParams(""), "");
  assert.equal(stripBrokerLoginParams("?other=x"), "?other=x");
});

test("every backend failure code maps to an actionable sentence naming the broker", () => {
  const codes = [
    "no_pending_login",
    "login_expired",
    "state_mismatch",
    "state_missing",
    "not_ready",
    "not_configured",
    "broker_denied",
    "missing_credential",
    "exchange_failed",
  ];
  for (const code of codes) {
    for (const broker of ["zerodha", "dhan"]) {
      const text = describeBrokerLoginFailure(broker, code);
      assert.ok(text.length > 0, `${code} must produce a message`);
      assert.ok(
        text.includes(brokerLabel(broker)),
        `${code} must name the broker so the two cards are never confused`,
      );
      // No raw snake_case code should leak into a message we have a real sentence for.
      assert.ok(!text.includes(code), `${code} must be explained, not echoed`);
    }
  }
});

test("an UNKNOWN failure code is surfaced rather than flattened away", () => {
  const text = describeBrokerLoginFailure("dhan", "some_new_backend_reason");
  assert.ok(text.includes("Dhan"));
  // Rendered as itself (spaced) so a newly added backend reason is visible instead of
  // being hidden behind a generic "something went wrong".
  assert.ok(text.includes("some new backend reason"));
});

test("a missing reason still yields a usable message", () => {
  assert.ok(describeBrokerLoginFailure("zerodha", null).includes("Zerodha"));
  assert.ok(describeBrokerLoginFailure("zerodha", "").includes("Zerodha"));
});

test("the success notice states what connecting does NOT do", () => {
  const text = describeBrokerLoginOutcome({ broker: "dhan", status: "connected", reason: null });
  assert.ok(text.includes("Dhan is connected"));
  // Connecting a broker is not selecting it and is not arming live trading. An operator who
  // conflates those has misread the system, so the notice says so explicitly.
  assert.match(text, /does not change which broker is active/i);
  assert.match(text, /arm live trading/i);
});

test("a failure outcome routes through the failure description", () => {
  const text = describeBrokerLoginOutcome({ broker: "zerodha", status: "failed", reason: "login_expired" });
  assert.equal(text, describeBrokerLoginFailure("zerodha", "login_expired"));
});

test("broker labels are the operator-facing names", () => {
  assert.equal(brokerLabel("zerodha"), "Zerodha");
  assert.equal(brokerLabel("dhan"), "Dhan");
});
