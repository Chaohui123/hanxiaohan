import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, normalizePage, validateBatch, isClosedSessionError, assertExpectedCompany, sellerSessionAction, ensureSellerSession } from "../src/local-collector.mjs";

function envelope(query = "телефон", offset = "0", total = "1") {
  const request = { text: "", limit: "50", offset, sort_by: "count", sort_dir: "desc", period: "days_7" };
  return {
    request, httpStatus: 200,
    rawBody: JSON.stringify({ data: [{ query, count: 100, uniqQueriesWCa: 10 }], offset, total }),
  };
}

test("collector preserves valid Russian text and numeric zero", () => {
  const result = normalizePage(envelope());
  assert.equal(result.body.data[0].query, "телефон");
  assert.equal(result.body.data[0].count, 100);
});

test("collector rejects login and invalid session statuses", () => {
  assert.throws(() => normalizePage({ ...envelope(), httpStatus: 403 }), error => error.code === "SESSION_OR_CONTEXT_INVALID");
  assert.throws(() => normalizePage({ ...envelope(), rawBody: "<html>login</html>" }), /valid JSON/);
});

test("collector rejects offset and duplicate page drift", () => {
  assert.throws(() => normalizePage({ ...envelope(), request: { ...envelope().request, offset: "50" } }), /offset/);
  assert.throws(() => validateBatch([normalizePage(envelope()), normalizePage(envelope())], false), /multiple pages/);
});

test("collector rejects changed total and incomplete batches", () => {
  assert.throws(() => validateBatch([normalizePage(envelope("a", "0", "2"))], true), /Incomplete batch/);
  assert.throws(() => validateBatch([normalizePage(envelope("a", "0", "1")), normalizePage(envelope("b", "50", "2"))], false), /Total changed/);
});

test("collector accepts only bounded local options", () => {
  assert.deepEqual(parseArgs(["--max-pages=1"]).maxPages, 1);
  assert.throws(() => parseArgs(["--max-pages=-1"]));
  assert.throws(() => parseArgs(["--session=bad session"]));
});

test("collector recognizes only closed task tabs as recoverable", () => {
  assert.equal(isClosedSessionError(new Error("No tab with given id 203942741.")), true);
  assert.equal(isClosedSessionError(new Error('session "ozon-search" tab was closed')), true);
  assert.equal(isClosedSessionError(new Error("extension_not_connected")), false);
  assert.equal(isClosedSessionError(new Error("Seller login required")), false);
});

test("collector accepts only the authorized Seller company", () => {
  assert.equal(assertExpectedCompany("5140601", "5140601"), "5140601");
  assert.throws(() => assertExpectedCompany("9999999", "5140601"), error => error.code === "SELLER_WRONG_ACCOUNT" && /5140601/.test(error.message) && /9999999/.test(error.message));
});

test("collector requires a configured numeric Seller company", () => {
  for (const expected of ["", "unknown", "5140601 extra"]) {
    assert.throws(() => assertExpectedCompany("5140601", expected), error => error.code === "SELLER_ACCOUNT_UNVERIFIED");
  }
});

test("seller session selects login and the authorized account before reading the table", () => {
  assert.deepEqual(sellerSessionAction({ loginSelector: "#login", accountCandidates: [] }), { action: "click_login", selector: "#login" });
  const state = {
    accountChoiceVisible: true,
    accountCandidates: [{ selector: "#other", text: "Другой аккаунт" }, { selector: "#main", text: "ТехноМир CH" }],
  };
  assert.deepEqual(sellerSessionAction(state, "ТехноМир", true, false), { action: "click_account", selector: "#main" });
  assert.deepEqual(sellerSessionAction({ accountChoiceVisible: true, accountCandidates: [{ selector: "#only", text: "Saved account" }] }, "ТехноМир", true, false), { action: "click_account", selector: "#only" });
  assert.deepEqual(sellerSessionAction({ tableReady: true }, "ТехноМир", true, true), { action: "ready" });
});

test("seller session rejects ambiguous accounts and human verification", () => {
  const ambiguous = sellerSessionAction({ accountChoiceVisible: true, accountCandidates: [{ selector: "#a", text: "A" }, { selector: "#b", text: "B" }] });
  assert.equal(ambiguous.code, "SELLER_ACCOUNT_CHOICE_REQUIRED");
  const verification = sellerSessionAction({ authInteractionRequired: true, loginSelector: "#login" });
  assert.equal(verification.code, "SELLER_AUTH_INTERACTION_REQUIRED");
});

test("seller session clicks login and account through WebBridge before collection", async t => {
  const states = [
    { tableReady: false, authInteractionRequired: false, accountChoiceVisible: false, loginSelector: "#login", accountCandidates: [], text: "login" },
    { tableReady: false, authInteractionRequired: false, accountChoiceVisible: true, loginSelector: null, accountCandidates: [{ selector: "#account", text: "ТехноМир CH" }], text: "choose" },
    { tableReady: true, authInteractionRequired: false, accountChoiceVisible: false, loginSelector: null, accountCandidates: [], text: "table" },
  ];
  let stateIndex = 0;
  const clicks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    let data;
    if (request.action === "evaluate") data = { type: "object", value: states[Math.min(stateIndex++, states.length - 1)] };
    else if (request.action === "mouse_click") {
      clicks.push(request.args.selector);
      data = { success: true };
    } else if (request.action === "cdp") data = {};
    else throw new Error(`Unexpected action ${request.action}`);
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  const result = await ensureSellerSession("http://127.0.0.1:10086/command", "account-flow-test", { timeoutMs: 100, pollIntervalMs: 1 });
  assert.deepEqual(result, { loginButtonUsed: true, accountChoiceUsed: true });
  assert.deepEqual(clicks, ["#login", "#account"]);
});

test("seller session never guesses between multiple unlabelled accounts", async t => {
  const clicks = [];
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    const request = JSON.parse(options.body);
    if (request.action === "mouse_click") clicks.push(request.args.selector);
    const data = request.action === "evaluate" ? {
      type: "object",
      value: { tableReady: false, authInteractionRequired: false, accountChoiceVisible: true, loginSelector: null, accountCandidates: [{ selector: "#a", text: "A" }, { selector: "#b", text: "B" }] },
    } : {};
    return new Response(JSON.stringify({ ok: true, data }), { status: 200, headers: { "Content-Type": "application/json" } });
  });
  await assert.rejects(
    ensureSellerSession("http://127.0.0.1:10086/command", "account-flow-test", { timeoutMs: 100, pollIntervalMs: 1 }),
    error => error.code === "SELLER_ACCOUNT_CHOICE_REQUIRED",
  );
  assert.equal(clicks.length, 0);
});
