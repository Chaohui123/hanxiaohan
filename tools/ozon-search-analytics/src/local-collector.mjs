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

export function isClosedSessionError(error) {
  return /unknown session|session.*(?:not found|closed)|no tab with given id|tab was closed/i.test(error?.message || "");
}

async function closeOwnedTabs(endpoint, session) {
  try { await webbridge(endpoint, session, "close_session", {}); }
  catch (error) {
    if (!isClosedSessionError(error)) throw error;
  }
}

export function sellerSessionAction(state, accountLabel = "ТехноМир", loginClicked = false, accountClicked = false) {
  if (state?.tableReady) return { action: "ready" };
  if (state?.authInteractionRequired) {
    return { action: "error", code: "SELLER_AUTH_INTERACTION_REQUIRED", message: "Ozon requires a captcha or verification code; automatic collection must stop" };
  }
  if (!accountClicked) {
    const normalize = value => String(value || "").replace(/\s+/g, " ").trim().toLocaleLowerCase();
    const expected = normalize(accountLabel);
    const candidates = Array.isArray(state?.accountCandidates) ? state.accountCandidates : [];
    const labelled = expected ? candidates.filter(candidate => normalize(candidate.text).includes(expected)) : [];
    if (labelled.length === 1) return { action: "click_account", selector: labelled[0].selector };
    if (labelled.length > 1) {
      return { action: "error", code: "SELLER_ACCOUNT_CHOICE_REQUIRED", message: "More than one Ozon account matches the authorized store label" };
    }
    if (state?.accountChoiceVisible && candidates.length === 1) return { action: "click_account", selector: candidates[0].selector };
    if (state?.accountChoiceVisible && candidates.length > 1) {
      return { action: "error", code: "SELLER_ACCOUNT_CHOICE_REQUIRED", message: "Ozon account choice is ambiguous and does not contain the authorized store label" };
    }
  }
  if (!loginClicked && state?.loginSelector) return { action: "click_login", selector: state.loginSelector };
  return { action: "wait" };
}

export function sellerSessionSnapshotSource(accountLabel) {
  return `(() => {
    const expectedLabel = ${JSON.stringify(accountLabel)};
    const visible = element => !!(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const normalize = value => String(value || '').replace(/\\s+/g, ' ').trim();
    const mask = value => normalize(value).replace(/[\\w.+-]+@[\\w.-]+\\.[A-Za-z]{2,}/g, '[email]').replace(/\\+?\\d[\\d\\s()-]{7,}\\d/g, '[phone]');
    const controls = [...document.querySelectorAll('button,[role="button"],a[href]')].filter(element => {
      if (!visible(element) || element.disabled || element.getAttribute('aria-disabled') === 'true') return false;
      return !element.parentElement?.closest('button,[role="button"],a[href]');
    });
    const login = controls.find(element => /^(?:Войти|Выбрать аккаунт|登录|选择账户|选择账号|选择账户登录|Log in|Sign in|Choose account)$/i.test(normalize(element.innerText || element.getAttribute('aria-label'))));
    if (login) login.setAttribute('data-onzo-search-login', 'true');
    const excluded = /^(?:Зарегистрироваться|Регистрация|注册|Sign up|Помощь|帮助|Help|Условия обработки персональных данных|Условия|条款|Далее|Next|Продолжить|Continue|继续|Отправить код|Send code|Сменить аккаунт|Другой аккаунт|Добавить аккаунт|Use another account|使用其他账户|其他账户|Выбрать другой аккаунт)$/i;
    const accountCandidates = [];
    for (const element of controls) {
      if (element === login) continue;
      const text = normalize(element.innerText || element.getAttribute('aria-label'));
      if (!text || excluded.test(text)) continue;
      element.setAttribute('data-onzo-search-account', String(accountCandidates.length));
      accountCandidates.push({ selector: '[data-onzo-search-account="' + accountCandidates.length + '"]', text });
    }
    const text = document.body?.innerText || '';
    return {
      tableReady: document.querySelectorAll('table tbody tr td a').length > 0,
      authInteractionRequired: !!document.querySelector('iframe[src*="captcha" i]') || /captcha|Введите код|проверочный код|验证码|Докажите, что вы не робот|Подтвердите, что вы не робот/i.test(text),
      accountChoiceVisible: /Выберите аккаунт|Выбор аккаунта|Choose an account|Choose account|选择账户|选择账号|选择登录账户/i.test(text),
      loginSelector: login ? '[data-onzo-search-login="true"]' : null,
      accountCandidates,
      accountLabelPresent: expectedLabel && text.toLocaleLowerCase().includes(expectedLabel.toLocaleLowerCase()),
      text: mask(text).slice(0, 500),
    };
  })()`;
}

export async function ensureSellerSession(endpoint, session, options = {}) {
  const accountLabel = options.accountLabel || "ТехноМир";
  const timeoutMs = options.timeoutMs ?? 60_000;
  const pollIntervalMs = options.pollIntervalMs ?? 500;
  const deadline = Date.now() + timeoutMs;
  let loginClicked = false;
  let accountClicked = false;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(endpoint, session, sellerSessionSnapshotSource(accountLabel));
    const decision = sellerSessionAction(lastState, accountLabel, loginClicked, accountClicked);
    if (decision.action === "ready") return { loginButtonUsed: loginClicked, accountChoiceUsed: accountClicked };
    if (decision.action === "error") {
      const error = new Error(decision.message);
      error.code = decision.code;
      throw error;
    }
    if (decision.action === "click_login" || decision.action === "click_account") {
      await webbridge(endpoint, session, "mouse_click", { selector: decision.selector, focus_emulation: true });
      if (decision.action === "click_login") loginClicked = true;
      else accountClicked = true;
      await activate(endpoint, session);
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  const accountFlow = loginClicked || accountClicked || lastState?.accountChoiceVisible;
  const error = new Error(accountFlow
    ? `Ozon account sign-in did not reach the query table: ${lastState?.text || "empty page"}`
    : `Seller table did not load; activate Chrome and check the session: ${lastState?.text || "empty page"}`);
  error.code = accountFlow ? "SELLER_ACCOUNT_SIGN_IN_TIMEOUT" : "SELLER_SESSION_OR_TAB_NOT_READY";
  throw error;
}

async function preparePage(endpoint, session) {
  await closeOwnedTabs(endpoint, session);
  await webbridge(endpoint, session, "navigate", { url: SELLER_URL, newTab: true, group_title: "搜索查询本机采集" });
  await activate(endpoint, session);
  const current = await evaluate(endpoint, session, "location.href");
  if (current !== SELLER_URL) await webbridge(endpoint, session, "navigate", { url: SELLER_URL });
  await activate(endpoint, session);
  const accountSelection = await ensureSellerSession(endpoint, session, {
    accountLabel: process.env.SEARCH_ANALYTICS_ACCOUNT_LABEL || "ТехноМир",
  });
  const installed = await evaluate(endpoint, session, instrumentationSource());
  if (!installed) throw new Error("Could not install the readonly request observer");
  await activate(endpoint, session);
  const target = await evaluate(endpoint, session, `(() => {
    const selected = document.querySelector('button[data-selected="true"]');
    const current = Number((selected?.textContent || '').trim());
    if (!Number.isInteger(current)) return null;
    const buttons = [...document.querySelectorAll('button')].filter(element => element.offsetParent && !element.disabled && /^\\d+$/.test((element.textContent || '').trim()));
    const button = buttons.find(element => Number(element.textContent.trim()) === current + 1) || buttons.find(element => Number(element.textContent.trim()) === current - 1);
    if (!button) return null;
    const page = Number(button.textContent.trim());
    button.setAttribute('data-onzo-search-page', String(page));
    button.scrollIntoView({ block: 'center', inline: 'center' });
    return { current, page, selector: 'button[data-onzo-search-page="' + page + '"]' };
  })()`);
  if (!target) throw new Error("Could not find an enabled adjacent pagination button for native request context");
  await webbridge(endpoint, session, "mouse_click", { selector: target.selector, focus_emulation: true });
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
  return { ...template, accountSelection };
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

export function assertExpectedCompany(actualCompanyId, expectedCompanyId) {
  const actual = String(actualCompanyId ?? "").trim();
  const expected = String(expectedCompanyId ?? "").trim();
  if (!/^\d{1,32}$/.test(expected)) {
    const error = new Error("SEARCH_ANALYTICS_COMPANY_ID must be the numeric company ID of the authorized Seller account");
    error.code = "SELLER_ACCOUNT_UNVERIFIED";
    throw error;
  }
  if (actual !== expected) {
    const error = new Error(`Seller account mismatch: expected company ${expected}, received ${actual || "unknown"}; refusing to collect or publish`);
    error.code = "SELLER_WRONG_ACCOUNT";
    throw error;
  }
  return actual;
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
  let completed = false;
  await atomicJson(pendingFile, pending);
  try {
    const context = await preparePage(endpoint, options.session);
    assertExpectedCompany(context.companyId, process.env.SEARCH_ANALYTICS_COMPANY_ID);
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
      accountSelection: context.accountSelection,
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
    completed = true;
    return { directory, manifest };
  } catch (error) {
    await atomicJson(pendingFile, { ...pending, finishedAt: new Date().toISOString(), status: "FAILED", error: error.message, errorCode: error.code || "COLLECTION_FAILED" });
    throw error;
  } finally {
    if (completed) await closeOwnedTabs(endpoint, options.session).catch(error => console.warn(`任务标签页清理失败：${error.message}`));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  collect(parseArgs(process.argv.slice(2))).then(({ directory, manifest }) => {
    console.log(JSON.stringify({ status: manifest.status, complete: manifest.complete, pages: manifest.pageCount, rows: manifest.rowCount, total: manifest.total, contentSha256: manifest.contentSha256, directory }, null, 2));
  }).catch(error => { console.error(error.message); process.exitCode = 1; });
}
