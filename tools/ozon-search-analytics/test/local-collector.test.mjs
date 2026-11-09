import test from "node:test";
import assert from "node:assert/strict";
import { parseArgs, normalizePage, validateBatch } from "../src/local-collector.mjs";

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
