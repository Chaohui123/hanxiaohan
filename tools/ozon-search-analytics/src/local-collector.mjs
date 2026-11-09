import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const SELLER_URL = "https://seller.ozon.ru/app/analytics/what-to-sell/all-queries";
const QUERY_PATH = "/api/site/searchteam/Stats/queries/search/v2";
const COLLECTOR_VERSION = "local-chrome-v1";
const DEFAULT_SESSION = "ozon-search-local-fallback";

export function parseArgs(argv) {
  const args = { output: "data/search-analytics", maxPages: 0, session: DEFAULT_SESSION };
  for (const arg of argv) {
    if (arg.startsWith("--output=")) args.output = arg.slice("--output=".length);
    else if (arg.startsWith("--max-pages=")) args.maxPages = Number(arg.slice("--max-pages=".length));
    else if (arg.startsWith("--session=")) args.session = arg.slice("--session=".length);
    else throw new Error(`Unknown argument: ${arg}`);
  }
  if (!Number.isInteger(args.maxPages) || args.maxPages < 0) throw new Error("max-pages must be a non-negative integer");
  if (!/^[\w-]+$/.test(args.session)) throw new Error("Invalid WebBridge session");
  return args;
}

export function normalizePage(envelope) {
  if (!envelope || typeof envelope !== "object") throw new Error("Empty browser response");
  if (envelope.httpStatus !== 200) {
    const error = new Error(`Ozon query endpoint HTTP ${envelope.httpStatus}`);
    error.code = envelope.httpStatus === 401 || envelope.httpStatus === 403 ? "SESSION_OR_CONTEXT_INVALID" : "UPSTREAM_HTTP_ERROR";
    throw error;
  }
  let body;
  try { body = JSON.parse(envelope.rawBody); }
  catch { throw new Error("Query response is not valid JSON"); }
  if (!Array.isArray(body.data) || !/^\d+$/.test(String(body.total)) || !/^\d+$/.test(String(body.offset))) {
    throw new Error("Unexpected query response schema");
  }
  const expectedOffset = Number(envelope.request.offset);
  if (Number(body.offset) !== expectedOffset) throw new Error("Response offset differs from the request");
  if (body.data.length > Number(envelope.request.limit)) throw new Error("Response exceeds the requested page size");
  const queries = new Set();
  const fields = new Set();
  for (const row of body.data) {
    if (!row || typeof row.query !== "string" || !row.query.trim()) throw new Error("Missing query text");
    if (queries.has(row.query)) throw new Error("Duplicate query within a page");
    queries.add(row.query);
    for (const key of Object.keys(row)) fields.add(key);
  }
  if (!fields.has("count") || !fields.has("query")) throw new Error("Required query fields are absent");
  return { body, fields: [...fields].sort() };
}

export function validateBatch(pages, complete) {
  if (!pages.length) throw new Error("No pages collected");
  const total = Number(pages[0].body.total);
  const queries = new Set();
  for (const page of pages) {
    if (Number(page.body.total) !== total) throw new Error("Total changed between pages; discard the whole batch");
    for (const row of page.body.data) {
      if (queries.has(row.query)) throw new Error(`Query appears on multiple pages: ${row.query.slice(0, 80)}`);
      queries.add(row.query);
    }
  }
  if (complete && queries.size !== total) throw new Error(`Incomplete batch: ${queries.size}/${total}`);
  return { total, rowCount: queries.size };
}

async function atomicJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, file);
}

async function webbridge(endpoint, session, action, args = {}) {
  let response;
  try {
    response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action, args, session }),
      signal: AbortSignal.timeout(90_000),
    });
  } catch (error) {
    const wrapped = new Error(`WebBridge unavailable: ${error.message}`);
    wrapped.code = "WEBBRIDGE_UNAVAILABLE";
    throw wrapped;
  }
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(result.error?.message || `WebBridge action failed: ${action}`);
    error.code = result.error?.code || "WEBBRIDGE_ACTION_FAILED";
    throw error;
  }
  return result.data;
}

async function evaluate(endpoint, session, code) {
  const result = await webbridge(endpoint, session, "evaluate", { code });
  if (result?.type === "undefined" || result?.subtype === "error") throw new Error("Browser evaluation failed");
  return result?.value;
}

async function activate(endpoint, session) {
  await webbridge(endpoint, session, "cdp", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: true } });
  try { await webbridge(endpoint, session, "cdp", { method: "Page.bringToFront", params: {} }); }
  finally { await webbridge(endpoint, session, "cdp", { method: "Emulation.setFocusEmulationEnabled", params: { enabled: false } }); }
}

function instrumentationSource() {
  return `(() => {
    const key = '__ozonSearchReadonlyCapture';
    const state = window[key] = { requests: [], internal: false };
    const endpoint = '${QUERY_PATH}';
    const originalFetch = window.fetch;
    window.fetch = async function(input, init) {
      const url = typeof input === 'string' ? input : input.url;
      const watched = url.includes(endpoint) && !state.internal;
      const headers = new Headers(init?.headers || (input instanceof Request ? input.headers : undefined));
      const response = await originalFetch.apply(this, arguments);
      if (watched) {
        const item = { kind: 'fetch', url, method: init?.method || input.method || 'GET', requestBody: init?.body || null, headers, status: response.status };
        state.requests.push(item);
        response.clone().text().then(text => { item.responseText = text; });
      }
      return response;
    };
    const open = XMLHttpRequest.prototype.open;
    const setHeader = XMLHttpRequest.prototype.setRequestHeader;
    const send = XMLHttpRequest.prototype.send;
    XMLHttpRequest.prototype.open = function(method, url) {
      this.__ozonSearch = { method, url: String(url), headers: {} };
      return open.apply(this, arguments);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(name, value) {
      if (this.__ozonSearch) this.__ozonSearch.headers[name] = value;
      return setHeader.apply(this, arguments);
    };
    XMLHttpRequest.prototype.send = function(body) {
      const meta = this.__ozonSearch;
      if (meta?.url.includes(endpoint) && !state.internal) {
        const item = { kind: 'xhr', url: meta.url, method: meta.method, requestBody: body, headers: meta.headers };
        state.requests.push(item);
        this.addEventListener('loadend', () => { item.status = this.status; item.responseText = this.responseText; });
      }
      return send.apply(this, arguments);
    };
    return true;
  })()`;
}

async function preparePage(endpoint, session) {
  try { await webbridge(endpoint, session, "find_tab", { url: "seller.ozon.ru" }); }
  catch { await webbridge(endpoint, session, "navigate", { url: SELLER_URL, newTab: true, group_title: "搜索查询本机采集" }); }
  await activate(endpoint, session);
  const current = await evaluate(endpoint, session, "location.href");
  if (current !== SELLER_URL) await webbridge(endpoint, session, "navigate", { url: SELLER_URL });
  await activate(endpoint, session);
  const ready = await evaluate(endpoint, session, `(async () => {
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (document.querySelectorAll('table tbody tr td a').length) return { ok: true };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    return { ok: false, url: location.href, text: (document.body.innerText || '').slice(0, 500) };
  })()`);
  if (!ready?.ok) {
    const error = new Error(`Seller table did not load; activate Chrome and check the session: ${ready?.text || "empty page"}`);
    error.code = "SELLER_SESSION_OR_TAB_NOT_READY";
    throw error;
  }
  const installed = await evaluate(endpoint, session, instrumentationSource());
  if (!installed) throw new Error("Could not install the readonly request observer");
  await activate(endpoint, session);
  const clicked = await evaluate(endpoint, session, `(() => {
    const current = Number(document.querySelector('button[data-selected="true"]')?.textContent || '1');
    const targetNumber = current === 1 ? '2' : '1';
    const button = [...document.querySelectorAll('button')].find(element => element.offsetParent && !element.disabled && (element.innerText || '').trim() === targetNumber);
    if (!button) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error("Could not trigger a native page transition to establish request context");
  const template = await evaluate(endpoint, session, `(async () => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      const state = window.__ozonSearchReadonlyCapture;
      const request = state?.requests.find(item => item.status === 200 && item.responseText);
      if (request) {
        const nativeRequest = JSON.parse(String(request.requestBody || '{}'));
        if (nativeRequest.period !== 'days_7' || nativeRequest.text !== '') return null;
        const headers = Object.fromEntries(new Headers(request.headers));
        state.template = { url: request.url, headers };
        const period = [...document.querySelectorAll('button')].map(element => (element.innerText || '').trim()).find(text => /7\\s*(?:天|дн)/i.test(text));
        return { headerNames: Object.keys(headers), companyId: headers['x-o3-company-id'] || null, period: period || null };
      }
      await new Promise(resolve => setTimeout(resolve, 250));
    }
    return null;
  })()`);
  if (!template?.companyId || !template.period) throw new Error("Could not establish the native 7-day request context from normal pagination");
  return template;
}

async function fetchPage(endpoint, session, offset) {
  const request = { text: "", limit: "50", offset: String(offset), sort_by: "count", sort_dir: "desc", period: "days_7" };
  const code = `(async () => {
    const state = window.__ozonSearchReadonlyCapture;
    if (!state?.template) return { httpStatus: 0, error: 'Missing native request context' };
    const request = ${JSON.stringify(request)};
    state.internal = true;
    try {
      const response = await fetch(state.template.url, { method: 'POST', credentials: 'same-origin', headers: state.template.headers, body: JSON.stringify(request) });
      const rawBody = await response.text();
      return { request, httpStatus: response.status, serverDate: response.headers.get('date'), contentType: response.headers.get('content-type'), rawBody, headerNames: Object.keys(state.template.headers).sort() };
    } catch (error) {
      return { request, httpStatus: 0, error: String(error).slice(0, 300) };
    } finally { state.internal = false; }
  })()`;
  const envelope = await evaluate(endpoint, session, code);
  if (!envelope || envelope.error) throw new Error(envelope?.error || "No response from browser");
  return envelope;
}

export async function collect(options) {
  const endpoint = process.env.WEBBRIDGE_URL || "http://127.0.0.1:10086/command";
  const startedAt = new Date().toISOString();
  const runId = `${startedAt.replace(/[:.]/g, "-")}${options.maxPages ? "-sample" : ""}`;
  const directory = path.resolve(options.output, "runs", runId);
  const pendingFile = path.join(directory, "manifest.pending.json");
  const pages = [];
  const fields = new Set();
  let pending = { runId, collectorVersion: COLLECTOR_VERSION, startedAt, status: "RUNNING", complete: false, sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN", pageCount: 0 };
  await atomicJson(pendingFile, pending);
  try {
    const context = await preparePage(endpoint, options.session);
    const firstEnvelope = await fetchPage(endpoint, options.session, 0);
    const first = normalizePage(firstEnvelope);
    const total = Number(first.body.total);
    const expectedPages = Math.ceil(total / 50);
    const pageCount = options.maxPages ? Math.min(options.maxPages, expectedPages) : expectedPages;
    const complete = pageCount === expectedPages;
    for (let index = 0; index < pageCount; index++) {
      const offset = index * 50;
      const envelope = index === 0 ? firstEnvelope : await fetchPage(endpoint, options.session, offset);
      const normalized = normalizePage(envelope);
      normalized.fields.forEach(field => fields.add(field));
      const rawHash = createHash("sha256").update(envelope.rawBody, "utf8").digest("hex");
      const page = { index: index + 1, offset, rawHash, serverDate: envelope.serverDate, ...normalized };
      pages.push(page);
      await atomicJson(path.join(directory, `page-${String(index + 1).padStart(4, "0")}.json`), {
        request: envelope.request, httpStatus: envelope.httpStatus, serverDate: envelope.serverDate,
        contentType: envelope.contentType, requestHeaderNames: envelope.headerNames,
        responseSha256: rawHash, rawBody: envelope.rawBody,
      });
      if ((index + 1) % 10 === 0 || index + 1 === pageCount) {
        pending = { ...pending, pageCount: index + 1, rowCount: pages.reduce((sum, item) => sum + item.body.data.length, 0), total };
        await atomicJson(pendingFile, pending);
        console.log(`已采集 ${index + 1}/${pageCount} 页，${pending.rowCount}/${total} 行`);
      }
    }
    const counts = validateBatch(pages, complete);
    const manifest = {
      runId, collectorVersion: COLLECTOR_VERSION, parserVersion: "search-v2-fields-v1",
      startedAt, finishedAt: new Date().toISOString(), status: complete ? "COLLECTED" : "SAMPLE_VALIDATED",
      complete, sourceType: "ozon_seller_ui_native_query_report", sourceDependency: "LOCAL_CHROME_ACTIVE_TAB_AND_LOGIN",
      sourceUrl: SELLER_URL, endpoint: QUERY_PATH, companyId: context.companyId,
      requestHeaderNames: context.headerNames, nativePeriod: { requested: "days_7", label: context.period, start: null, end: null, timezone: null, basis: "Ozon-relative-period-at-collection; no calendar dates returned by this endpoint" },
      filters: { text: "", sort_by: "count", sort_dir: "desc", period: "days_7" },
      expectedPages, pageCount, total: counts.total, rowCount: counts.rowCount,
      coverage: "OBSERVED_QUERY_SET_NOT_UNLIMITED_MARKET", fields: [...fields].sort(),
      pages: pages.map(page => ({ page: page.index, offset: page.offset, rows: page.body.data.length, serverDate: page.serverDate, responseSha256: page.rawHash })),
      contentSha256: createHash("sha256").update(pages.map(page => page.rawHash).join("\n")).digest("hex"),
      note: "Seller原生市场搜索查询数据，不等于本店SKU曝光或订单。空数组与缺失会员字段不得写成0。",
    };
    await atomicJson(path.join(directory, "manifest.json"), manifest);
    await rm(pendingFile, { force: true });
    return { directory, manifest };
  } catch (error) {
    await atomicJson(pendingFile, { ...pending, finishedAt: new Date().toISOString(), status: "FAILED", error: error.message, errorCode: error.code || "COLLECTION_FAILED" });
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collect(parseArgs(process.argv.slice(2))).then(({ directory, manifest }) => {
    console.log(JSON.stringify({ status: manifest.status, complete: manifest.complete, pages: manifest.pageCount, rows: manifest.rowCount, total: manifest.total, contentSha256: manifest.contentSha256, directory }, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
