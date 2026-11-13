import assert from "node:assert/strict";
import test from "node:test";
import { antigravityResultError, HYDROGEN_MODEL, OPUS_MODEL, resolveAntigravityOptions } from "./antigravity-config.mjs";

const required = ["--prompt-file", "prompt.txt", "--output", "result.json"];

test("defaults and explicit route are fixed to Opus High", () => {
  assert.equal(resolveAntigravityOptions(required).model, OPUS_MODEL);
  assert.equal(resolveAntigravityOptions(required).effort, "high");
  assert.equal(resolveAntigravityOptions([...required, "--model", OPUS_MODEL, "--effort", "high"]).model, OPUS_MODEL);
});

test("Hydrogen High is also an allowed Antigravity route", () => {
  assert.equal(resolveAntigravityOptions([...required, "--model", HYDROGEN_MODEL, "--effort", "high"]).model, HYDROGEN_MODEL);
});

test("other models, efforts and skipped permissions fail before spawn", () => {
  assert.throws(() => resolveAntigravityOptions([...required, "--model", "other"]), /Only/);
  assert.throws(() => resolveAntigravityOptions([...required, "--effort", "low"]), /Only/);
  assert.throws(() => resolveAntigravityOptions([...required, "--dangerously-skip-permissions"]), /forbidden/);
});

test("actual model and permission mode must match the verified sandbox route", () => {
  const base = { model: OPUS_MODEL, result: { status: "SUCCESS", response: "OK", usage: { total_tokens: 1 } }, exitCode: 0 };
  assert.equal(antigravityResultError({ ...base, init: { model: OPUS_MODEL, permission_mode: "request-review" } }), null);
  assert.match(antigravityResultError({ ...base, init: { model: "other", permission_mode: "request-review" } }), /does not match/);
  assert.match(antigravityResultError({ ...base, init: { model: OPUS_MODEL, permission_mode: "bypass" } }), /permission mode/);
  assert.match(antigravityResultError({ ...base, init: null }), /does not match/);
});

test("empty content and missing usage are rejected", () => {
  const init = { model: OPUS_MODEL, permission_mode: "request-review" };
  assert.match(antigravityResultError({ model: OPUS_MODEL, init, result: { status: "SUCCESS", response: "", usage: { total_tokens: 1 } }, exitCode: 0 }), /no content/);
  assert.match(antigravityResultError({ model: OPUS_MODEL, init, result: { status: "SUCCESS", response: "OK", usage: { total_tokens: 0 } }, exitCode: 0 }), /no valid token usage/);
});
