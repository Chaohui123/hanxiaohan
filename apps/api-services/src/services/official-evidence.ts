import { ProxyAgent, fetch as undiciFetch } from "undici";

export const OFFICIAL_HOSTNAMES = new Set([
  "ai.google.dev",
  "developers.google.com",
  "one.google.com",
  "support.google.com",
  "cloud.google.com",
]);

export const MAX_OFFICIAL_URLS = 8;
export const MAX_OFFICIAL_REDIRECTS = 3;
export const MAX_OFFICIAL_RESPONSE_BYTES = 2 * 1024 * 1024;
export const MAX_SOURCE_EVIDENCE_CHARS = 8000;
export const MAX_TOTAL_EVIDENCE_CHARS = 48_000;
export const OFFICIAL_FETCH_TIMEOUT_MS = 10_000;

const HTTP_URL_PATTERN = /https?:\/\/[^\s<>"'，。；：！？、）】》]+/gi;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const HTML_CONTENT_TYPES = new Set(["text/html", "application/xhtml+xml"]);
const TEXT_CONTENT_TYPES = new Set(["text/plain"]);

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  apos: "'",
  copy: "©",
  deg: "°",
  euro: "€",
  gt: ">",
  hellip: "…",
  laquo: "«",
  ldquo: "“",
  lsquo: "‘",
  lt: "<",
  mdash: "—",
  nbsp: " ",
  ndash: "–",
  plusmn: "±",
  pound: "£",
  quot: '"',
  raquo: "»",
  rdquo: "”",
  reg: "®",
  rsquo: "’",
  times: "×",
  trade: "™",
  yen: "¥",
};

const KEYWORD_STOP_WORDS = new Set([
  "about", "after", "all", "and", "api", "are", "audio", "before", "can", "com", "content",
  "daily", "developer", "dev", "docs", "for", "free", "from", "generation", "google", "have",
  "http", "https", "input", "into", "learning", "model", "models", "more", "not", "official",
  "only", "output", "per", "price", "pricing", "source", "speech", "start", "starting", "stream",
  "temp", "text", "that", "the", "their", "then", "this", "through", "use", "used", "using",
  "very", "voice", "with", "www", "your",
]);

type OfficialSourceTheme = "speech" | "pricing" | "model" | "image" | "omni" | "billing" | "generic";

const TOPIC_KEYWORDS: Record<Exclude<OfficialSourceTheme, "generic">, string[]> = {
  speech: [
    "speech_metadata", "Russian", "Sulafat", "WAV", "PCM", "24 kHz", "24kHz", "16-bit", "16bit",
    "sample_rate", "response_format", "voice", "audio",
  ],
  pricing: [
    "Input price", "Output price", "Free of charge", "tokens per second", "December 31, 2026", "January 1, 2027",
  ],
  model: ["Inputs", "Output", "Text", "Image", "Video", "Audio", "PDF", "Token limits", "Context window"],
  image: ["aspect_ratio", "image_size", "reference images", "input images", "output_image", "1K", "2K", "4K"],
  omni: ["720p", "interpolation", "first frame", "last frame", "first_frame", "last_frame", "output_video", "resolution"],
  billing: ["Cloud credits", "billing account", "prepaid", "eligible", "eligibility", "credits"],
};

function getSourceTheme(sourceUrl?: string): OfficialSourceTheme {
  if (!sourceUrl) return "generic";
  let pathname: string;
  try {
    pathname = new URL(sourceUrl).pathname.toLowerCase();
  } catch {
    return "generic";
  }
  if (pathname.includes("speech")) return "speech";
  if (pathname.includes("pricing")) return "pricing";
  if (pathname.includes("/models/")) return "model";
  if (pathname.includes("omni")) return "omni";
  if (pathname.includes("image")) return "image";
  if (pathname.includes("billing") || pathname.includes("credits")) return "billing";
  return "generic";
}

function getTopicKeywords(sourceUrl: string | undefined, theme: OfficialSourceTheme): string[] {
  if (theme === "generic") return [];
  const keywords = [...TOPIC_KEYWORDS[theme]];
  if (theme === "model" && sourceUrl?.toLowerCase().includes("gemini-4-argon")) {
    keywords.unshift("Gemini 4 Argon");
  }
  return keywords;
}

interface OfficialReader {
  read(): Promise<{ done: boolean; value?: Uint8Array }>;
  cancel(reason?: unknown): Promise<void> | void;
}

interface OfficialBody {
  getReader(): OfficialReader;
}

export interface OfficialFetchResponse {
  status: number;
  headers: { get(name: string): string | null };
  body: OfficialBody | null;
}

export interface OfficialFetchInit {
  redirect: "manual";
  signal: AbortSignal;
  headers: Record<string, string>;
}

export type OfficialFetch = (url: string, init: OfficialFetchInit) => Promise<OfficialFetchResponse>;

export interface OfficialEvidenceDependencies {
  fetchImpl?: OfficialFetch;
  timeoutMs?: number;
}

export interface OfficialEvidenceSource {
  url: string;
  text: string;
  coveredKeywords: string[];
}

interface OfficialDocument {
  url: string;
  text: string;
}

export interface EvidenceSelection {
  text: string;
  coveredKeywords: string[];
  ranges?: Array<{ start: number; end: number }>;
}

export type OfficialEvidenceResult =
  | { kind: "none" }
  | { kind: "reject"; reason: string }
  | { kind: "ready"; sources: OfficialEvidenceSource[] };

class OfficialSourceError extends Error {}

let proxyAgentCache: { url: string; agent: ProxyAgent } | null = null;

function decodeEntities(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, entity: string) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x";
      const raw = entity.slice(hexadecimal ? 2 : 1);
      const codePoint = Number.parseInt(raw, hexadecimal ? 16 : 10);
      if (!Number.isInteger(codePoint) || codePoint <= 0 || codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff)) {
        return "�";
      }
      return String.fromCodePoint(codePoint);
    }
    return NAMED_ENTITIES[entity.toLowerCase()] ?? whole;
  });
}

function normalizeWhitespace(value: string): string {
  return value
    .replace(/\u00a0/g, " ")
    .replace(/[\t\f\v ]+/g, " ")
    .replace(/ *\r?\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function htmlToText(html: string): string {
  const withoutComments = html.replace(/<!--[\s\S]*?-->/g, " ");
  const main = withoutComments.match(/<main\b[^>]*>[\s\S]*?<\/main\s*>/i)?.[0];
  const mainOrPage = main || withoutComments;
  const article = mainOrPage.match(
    /<article\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bdevsite-article\b)[^>]*>[\s\S]*?<\/article\s*>/i,
  )?.[0] || mainOrPage.match(/<article\b[^>]*>[\s\S]*?<\/article\s*>/i)?.[0];
  const scoped = article || mainOrPage;
  const withoutBlocks = scoped.replace(
    /<(script|style|noscript|template|svg|nav)\b[^>]*>[\s\S]*?<\/\1\s*>/gi,
    " ",
  );
  const withStructure = withoutBlocks
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/t[dh]\s*>/gi, " | ")
    .replace(/<\/(p|div|section|article|main|h[1-6]|li|tr|table|pre|blockquote)\s*>/gi, "\n");
  const withoutTags = withStructure.replace(/<[^>]*>/g, " ");
  return normalizeWhitespace(decodeEntities(withoutTags));
}

export function extractGeminiModelIds(value: string): string[] {
  const models = new Set<string>();
  const withoutUrls = value.replace(HTTP_URL_PATTERN, " ");
  for (const match of withoutUrls.matchAll(/\bgemini-[a-z0-9_]+(?:[.-][a-z0-9_]+)*/gi)) {
    models.add(match[0].toLowerCase());
  }
  return [...models];
}

export function extractHttpUrls(value: string): string[] {
  const urls: string[] = [];
  for (const match of value.matchAll(HTTP_URL_PATTERN)) {
    let url = match[0];
    let changed = true;
    while (changed && url) {
      changed = false;
      const trailing = url.slice(-1);
      if (/[.,;:!?，。；：！？、]/.test(trailing)) {
        url = url.slice(0, -1);
        changed = true;
        continue;
      }
      const pairs: Record<string, string> = { ")": "(", "]": "[", "}": "{", "）": "（", "】": "【", "》": "《" };
      const opening = pairs[trailing];
      if (opening) {
        const closes = [...url].filter((char) => char === trailing).length;
        const opens = [...url].filter((char) => char === opening).length;
        if (closes > opens || /[）】》]/.test(trailing)) {
          url = url.slice(0, -1);
          changed = true;
        }
      }
    }
    if (url) urls.push(url);
  }
  return urls;
}

function hasDisallowedQuery(url: URL): boolean {
  for (const key of url.searchParams.keys()) {
    if (key !== "hl") return true;
  }
  return false;
}

const UGC_PATH_SEGMENTS = new Set([
  "search", "community", "communities", "forum", "forums", "thread", "threads",
  "question", "questions", "user", "users", "profile", "profiles",
]);

function decodeOfficialPath(pathname: string): string {
  let decoded = pathname;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const next = decodeURIComponent(decoded);
      if (next === decoded) break;
      decoded = next;
    } catch {
      throw new OfficialSourceError("官方 URL 路径编码无效");
    }
  }
  if ([...decoded].some((char) => {
    const codePoint = char.charCodeAt(0);
    return codePoint < 0x20 || codePoint === 0x7f || char === "\\";
  })) throw new OfficialSourceError("官方 URL 路径无效");
  if (decoded.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new OfficialSourceError("官方 URL 路径无效");
  }
  return decoded.toLowerCase();
}

function validateOfficialPath(url: URL): void {
  const path = decodeOfficialPath(url.pathname);
  const hostname = url.hostname.toLowerCase();
  if (hostname === "ai.google.dev") {
    if (path !== "/gemini-api/docs" && !path.startsWith("/gemini-api/docs/")) {
      throw new OfficialSourceError("ai.google.dev 仅允许 Gemini API 文档路径");
    }
    return;
  }
  if (hostname === "one.google.com") {
    if (!path.startsWith("/about/")) throw new OfficialSourceError("one.google.com 仅允许 /about/ 路径");
    return;
  }
  if (hostname === "support.google.com") {
    if (!/^\/[a-z0-9][a-z0-9._-]*\/answer\/\d+\/?$/.test(path)) {
      throw new OfficialSourceError("support.google.com 仅允许官方 answer 帮助页");
    }
    return;
  }
  const segments = path.split("/").filter(Boolean);
  if (segments.some((segment) => UGC_PATH_SEGMENTS.has(segment))) {
    throw new OfficialSourceError("官方来源禁止搜索、社区或用户内容路径");
  }
}

function isSuspiciousOfficialUrl(rawUrl: string): boolean {
  const authority = rawUrl.match(/^https?:\/\/([^/?#]*)/i)?.[1] || "";
  if (!authority) return false;
  const hostWithPort = authority.slice(authority.lastIndexOf("@") + 1).toLowerCase();
  const hostname = hostWithPort.startsWith("[") ? hostWithPort : hostWithPort.split(":", 1)[0];
  const withoutTrailingDots = hostname.replace(/\.+$/, "");
  for (const officialHostname of OFFICIAL_HOSTNAMES) {
    if (withoutTrailingDots === officialHostname || withoutTrailingDots.startsWith(`${officialHostname}.`)) return true;
  }
  return false;
}

export function normalizeOfficialUrl(rawUrl: string): string {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new OfficialSourceError("官方 URL 无效");
  }

  const authority = rawUrl.match(/^https:\/\/([^/?#]*)/i)?.[1] || "";
  if (url.protocol !== "https:") throw new OfficialSourceError("官方来源仅允许 HTTPS");
  if (authority.includes("@") || url.username || url.password) throw new OfficialSourceError("官方 URL 禁止 userinfo");
  if (url.port && url.port !== "443") throw new OfficialSourceError("官方 URL 禁止非默认端口");
  if (!OFFICIAL_HOSTNAMES.has(url.hostname.toLowerCase())) throw new OfficialSourceError("官方来源域名不在白名单");
  if (hasDisallowedQuery(url)) throw new OfficialSourceError("官方 URL 仅允许 hl 查询参数");
  validateOfficialPath(url);

  url.searchParams.set("hl", "en");
  url.searchParams.sort();
  url.hash = "";
  return url.toString();
}

export function safeOfficialUrl(normalizedUrl: string): string {
  const url = new URL(normalizeOfficialUrl(normalizedUrl));
  url.search = "";
  url.hash = "";
  return url.toString();
}

function getDefaultOfficialFetch(): OfficialFetch {
  const proxyUrl = (process.env.KNOWLEDGE_OFFICIAL_PROXY_URL || process.env.LEARNING_PROXY_URL || "").trim();
  if (!proxyUrl) {
    return async (url, init) => {
      const response = await fetch(url, { method: "GET", ...init });
      return response as unknown as OfficialFetchResponse;
    };
  }

  let parsed: URL;
  try {
    parsed = new URL(proxyUrl);
    if (!new Set(["http:", "https:", "socks5:"]).has(parsed.protocol)) throw new Error("unsupported protocol");
  } catch {
    throw new OfficialSourceError("官方来源代理配置无效");
  }

  if (!proxyAgentCache || proxyAgentCache.url !== proxyUrl) {
    try {
      proxyAgentCache = { url: proxyUrl, agent: new ProxyAgent(parsed.toString()) };
    } catch {
      throw new OfficialSourceError("官方来源代理初始化失败");
    }
  }
  const agent = proxyAgentCache.agent;
  return async (url, init) => {
    const response = await undiciFetch(url, { method: "GET", ...init, dispatcher: agent });
    return response as unknown as OfficialFetchResponse;
  };
}

async function readLimitedBody(response: OfficialFetchResponse): Promise<string> {
  if (!response.body) throw new OfficialSourceError("官方来源正文为空");
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      total += value.byteLength;
      if (total > MAX_OFFICIAL_RESPONSE_BYTES) {
        await Promise.resolve(reader.cancel("response too large")).catch(() => {});
        throw new OfficialSourceError("官方来源响应超过 2MiB");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof OfficialSourceError) throw error;
    throw new OfficialSourceError("官方来源响应读取失败或超时");
  }

  if (total === 0) throw new OfficialSourceError("官方来源正文为空");
  return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)), total).toString("utf8");
}

async function fetchOfficialDocument(
  rawUrl: string,
  fetchImpl: OfficialFetch,
  timeoutMs: number,
): Promise<OfficialDocument> {
  let currentUrl = normalizeOfficialUrl(rawUrl);
  const signal = AbortSignal.timeout(timeoutMs);
  let redirectCount = 0;

  for (;;) {
    let response: OfficialFetchResponse;
    try {
      response = await fetchImpl(currentUrl, {
        redirect: "manual",
        signal,
        headers: {
          Accept: "text/html, text/plain;q=0.9, application/xhtml+xml;q=0.9",
          "Accept-Language": "en-US,en;q=0.9",
          "User-Agent": "ONZO-Knowledge-Gate/1.0",
        },
      });
    } catch {
      throw new OfficialSourceError("官方来源请求失败或超时");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      if (redirectCount >= MAX_OFFICIAL_REDIRECTS) throw new OfficialSourceError("官方来源重定向超过 3 跳");
      const location = response.headers.get("location");
      if (!location) throw new OfficialSourceError("官方来源重定向缺少 Location");
      try {
        currentUrl = normalizeOfficialUrl(new URL(location, currentUrl).toString());
      } catch (error) {
        if (error instanceof OfficialSourceError) throw error;
        throw new OfficialSourceError("官方来源重定向地址无效");
      }
      redirectCount += 1;
      continue;
    }

    currentUrl = normalizeOfficialUrl(currentUrl);
    if (response.status < 200 || response.status >= 300) throw new OfficialSourceError("官方来源返回非 2xx 状态");

    const contentType = (response.headers.get("content-type") || "").split(";", 1)[0].trim().toLowerCase();
    const isHtml = HTML_CONTENT_TYPES.has(contentType);
    if (!isHtml && !TEXT_CONTENT_TYPES.has(contentType)) throw new OfficialSourceError("官方来源 Content-Type 非 HTML/纯文本");

    const rawBody = await readLimitedBody(response);
    const text = isHtml ? htmlToText(rawBody) : normalizeWhitespace(rawBody);
    if (text.replace(/\s/g, "").length < 20) throw new OfficialSourceError("官方来源无有效文本");
    return { url: safeOfficialUrl(currentUrl), text };
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function containsExactModel(text: string, model: string): boolean {
  return new RegExp(`(?<![a-z0-9._-])${escapeRegExp(model)}(?![a-z0-9._-])`, "i").test(text);
}

function addKeywords(target: string[], values: Iterable<string>): void {
  const seen = new Set(target.map((value) => value.toLowerCase()));
  for (const value of values) {
    const keyword = value.trim();
    if (!keyword || seen.has(keyword.toLowerCase())) continue;
    seen.add(keyword.toLowerCase());
    target.push(keyword);
  }
}

export function extractEvidenceKeywords(value: string, sourceUrl?: string): string[] {
  const models = extractGeminiModelIds(value);
  const theme = getSourceTheme(sourceUrl);
  const topicKeywords = getTopicKeywords(sourceUrl, theme);
  const keywords: string[] = [];
  const withoutUrls = value.replace(HTTP_URL_PATTERN, " ");

  addKeywords(keywords, models);
  addKeywords(keywords, topicKeywords);
  addKeywords(keywords, withoutUrls.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/gi) || []);
  addKeywords(keywords, withoutUrls.match(/[$€£¥₽]\s*\d+(?:[.,]\d+)?|\b\d+(?:[.,]\d+)+\s*(?:USD|RUB|CNY|EUR|美元|美金|卢布|元|₽)/gi) || []);
  addKeywords(keywords, withoutUrls.match(/\b\d+(?:\.\d+)?\s*-?\s*(?:khz|hz|bits?|kbps|mbps|fps|p|k|tokens?)\b/gi) || []);
  addKeywords(keywords, withoutUrls.match(/`([^`\n]{2,80})`/g)?.map((item) => item.slice(1, -1)) || []);
  addKeywords(keywords, withoutUrls.match(/\b20\d{2}\b/g) || []);
  const ordinaryWords = (withoutUrls.match(/\b[A-Za-z][A-Za-z0-9-]{2,}\b/g) || []).filter((word) => (
    !KEYWORD_STOP_WORDS.has(word.toLowerCase())
    && !models.some((model) => model.includes(word.toLowerCase()))
  ));
  addKeywords(keywords, ordinaryWords.slice(0, theme === "generic" ? 24 : 8));

  const minimumLength = Math.max(models.length + topicKeywords.length, 48);
  return keywords.slice(0, minimumLength);
}

function isMoneyKeyword(keyword: string): boolean {
  return /^[$€£¥₽]\s*\d+(?:[.,]\d+)?$/.test(keyword);
}

function isExactKeywordOccurrence(text: string, index: number, keyword: string): boolean {
  const before = text[index - 1];
  const after = text.slice(index + keyword.length);
  if (isModelKeyword(keyword)) {
    return (!before || !/[a-z0-9._-]/i.test(before)) && (!after[0] || !/[a-z0-9._-]/i.test(after[0]));
  }
  if (isMoneyKeyword(keyword)) {
    if (before && /[a-z0-9]/i.test(before)) return false;
    if (after[0] && /[a-z0-9]/i.test(after[0])) return false;
    if (/^,\s*\d/.test(after) || /^\.\d/.test(after)) return false;
    return true;
  }
  if (/^\d/.test(keyword)) {
    if (before && /[a-z0-9]/i.test(before)) return false;
    if (after[0] && /[a-z0-9]/i.test(after[0])) return false;
    if (/^,\s*\d/.test(after) || /^\.\d/.test(after)) return false;
  }
  return true;
}

function findKeywordIndices(text: string, keyword: string): number[] {
  const indices: number[] = [];
  const haystack = text.toLowerCase();
  const needle = keyword.toLowerCase();
  let from = 0;
  while (from <= haystack.length - needle.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) break;
    indices.push(index);
    from = index + Math.max(1, needle.length);
  }
  return indices.filter((index) => isExactKeywordOccurrence(text, index, keyword));
}

function findKeyword(text: string, keyword: string): number {
  return findKeywordIndices(text, keyword)[0] ?? -1;
}

function isModelKeyword(keyword: string): boolean {
  return /^gemini-[a-z0-9_]+(?:[.-][a-z0-9_]+)*$/i.test(keyword);
}

export interface EvidenceSelectionOptions {
  modelContextAfter?: number;
  preferAfterAnchors?: boolean;
}

export function selectEvidenceExcerpts(
  text: string,
  keywords: string[],
  maxChars = MAX_SOURCE_EVIDENCE_CHARS,
  options: EvidenceSelectionOptions = {},
): EvidenceSelection {
  if (maxChars <= 0) return { text: "", coveredKeywords: [], ranges: [] };
  const normalized = normalizeWhitespace(text);
  const presentKeywords = keywords.filter((keyword) => findKeyword(normalized, keyword) >= 0);
  if (normalized.length <= maxChars) {
    return {
      text: presentKeywords.length > 0 ? normalized : "",
      coveredKeywords: presentKeywords,
      ranges: presentKeywords.length > 0 ? [{ start: 0, end: normalized.length }] : [],
    };
  }

  const parts: string[] = [];
  const ranges: Array<{ start: number; end: number; anchor: number }> = [];
  const coveredKeywords: string[] = [];
  let used = 0;

  for (const keyword of keywords) {
    const occurrences = findKeywordIndices(normalized, keyword);
    if (occurrences.length === 0) continue;
    if (occurrences.some((index) => ranges.some((range) => index >= range.start && index + keyword.length <= range.end))) {
      coveredKeywords.push(keyword);
      continue;
    }

    let index = occurrences[0];
    if (ranges.length > 0) {
      const forward = options.preferAfterAnchors
        ? occurrences.filter((candidate) => ranges.some((range) => candidate >= range.anchor))
        : [];
      const candidates = forward.length > 0 ? forward : occurrences;
      let bestDistance = Number.POSITIVE_INFINITY;
      for (const candidate of candidates) {
        for (const range of ranges) {
          const distance = candidate < range.start
            ? range.start - candidate
            : candidate > range.end
              ? candidate - range.end
              : 0;
          if (distance < bestDistance) {
            bestDistance = distance;
            index = candidate;
          }
        }
      }
    }

    const modelKeyword = isModelKeyword(keyword);
    const priceContext = /price|free of charge/i.test(keyword);
    const contextBefore = modelKeyword ? 180 : priceContext ? 160 : 220;
    const contextAfter = modelKeyword ? options.modelContextAfter ?? 720 : priceContext ? 520 : 260;
    const separatorLength = parts.length > 0 ? 5 : 0;
    const remaining = maxChars - used - separatorLength;
    if (remaining < keyword.length) break;

    const desiredStart = Math.max(0, index - contextBefore);
    const desiredEnd = Math.min(normalized.length, Math.max(index + keyword.length + contextAfter, desiredStart + 480));
    let start = desiredStart;
    let end = desiredEnd;
    if (end - start > remaining) {
      if (modelKeyword) {
        const before = Math.min(contextBefore, Math.max(0, Math.floor((remaining - keyword.length) * 0.2)));
        start = Math.max(0, index - before);
        end = Math.min(normalized.length, start + remaining);
        if (index + keyword.length > end) {
          start = Math.max(0, index + keyword.length - remaining);
          end = Math.min(normalized.length, start + remaining);
        }
      } else {
        const context = Math.max(0, Math.floor((remaining - keyword.length) / 2));
        start = Math.max(0, Math.min(index - context, normalized.length - remaining));
        end = Math.min(normalized.length, start + remaining);
      }
      if (index < start || index + keyword.length > end) continue;
    }

    const excerpt = normalized.slice(start, end).trim();
    if (!excerpt || findKeyword(excerpt, keyword) < 0) continue;
    if (parts.length > 0) parts.push("\n[…]\n");
    parts.push(excerpt);
    ranges.push({ start, end, anchor: index });
    coveredKeywords.push(keyword);
    used += separatorLength + excerpt.length;
    if (used >= maxChars) break;
  }

  return { text: parts.join(""), coveredKeywords, ranges };
}

interface ModelSection {
  model: string;
  start: number;
  end: number;
}

function findModelSections(text: string): ModelSection[] {
  const headings: Array<{ model: string; start: number; lineStart: number }> = [];
  let lineStart = 0;
  for (const line of text.split("\n")) {
    const withoutTable = line.trim().replace(/^[|\s]+|[|\s]+$/g, "");
    const candidate = withoutTable.replace(/^[(（]\s*|\s*[)）]$/g, "").trim();
    const match = candidate.match(/^(gemini-[a-z0-9_]+(?:[.-][a-z0-9_]+)*)$/i);
    if (match) {
      const model = match[1].toLowerCase();
      headings.push({ model, start: lineStart + line.toLowerCase().indexOf(model), lineStart });
    }
    lineStart += line.length + 1;
  }
  return headings.map((heading, index) => ({
    model: heading.model,
    start: heading.start,
    end: headings[index + 1]?.lineStart ?? text.length,
  }));
}

function hasInputAndOutputPrice(text: string, start: number, end: number): boolean {
  const context = text.slice(start, end);
  return /input price/i.test(context) && /output price/i.test(context);
}

function hasPriceClaimInText(text: string, model: string): boolean {
  const sentences = text.split(/(?<=[。！？!?])|(?<=\.)\s+/);
  for (const sentence of sentences) {
    for (const clause of sentence.split(/[；;]/)) {
      if (!containsExactModel(clause, model)) continue;
      const affirmativeClause = clause
        .replace(/(?:没有|并无|无|未提供|不含|不是|并非)\s*(?:input price|output price|价格表|价格|定价|计费|price table|pricing)/gi, " ")
        .replace(/\b(?:has no|no|without|lacks|not)\s+(?:input price|output price|price table|pricing)\b/gi, " ");
      if (/\binput price\b|\boutput price\b|价格|定价|计费|免费|free of charge|[$€£¥₽]\s*\d/i.test(affirmativeClause)) return true;
    }
  }
  return false;
}

function hasModelPriceClaim(knowledgeText: string, model: string): boolean {
  const firstLineEnd = knowledgeText.indexOf("\n");
  const title = firstLineEnd >= 0 ? knowledgeText.slice(0, firstLineEnd) : knowledgeText;
  const content = firstLineEnd >= 0 ? knowledgeText.slice(firstLineEnd + 1) : "";
  const globalText = knowledgeText.replace(HTTP_URL_PATTERN, " ");
  if (/型号与价格|各型号.{0,20}(?:价格|定价|计费)|以下型号.{0,30}(?:价格|定价|计费)/.test(globalText)) return true;

  const claimTexts = containsExactModel(title, model) ? [title, content] : [content];
  return claimTexts.some((text) => hasPriceClaimInText(text.replace(HTTP_URL_PATTERN, " "), model));
}

function findIncompletePricingModel(
  documentText: string,
  selection: EvidenceSelection,
  models: string[],
  knowledgeText: string,
): string | undefined {
  const ranges = selection.ranges || [];
  const sections = findModelSections(documentText);
  for (const model of models) {
    const pricedSections = sections.filter((section) => (
      section.model === model && hasInputAndOutputPrice(documentText, section.start, section.end)
    ));
    if (pricedSections.length === 0) {
      if (hasModelPriceClaim(knowledgeText, model)) return model;
      continue;
    }

    const covered = pricedSections.some((section) => ranges.some((range) => (
      section.start >= range.start
      && section.start + model.length <= range.end
      && hasInputAndOutputPrice(documentText, section.start, Math.min(range.end, section.end))
    )));
    if (!covered) return model;
  }
  return undefined;
}

function cleanOfficialClaimNegations(value: string): string {
  return value
    .replace(/(?:不是来自|并非来自|并未确认|未能确认|无法确认|不能确认|尚未确认|没有确认|没有|并无|未有|未确认|不是|并非|不声称|不代表|并未|未能|无法|尚未|非|无)\s*(?:确认|证实|找到|发现|提供|核验|验证|查阅)?\s*(?:(?:google|gemini|谷歌)\s*)?(?:官方|official)(?:文档|资料|原文|来源|模型|价格|指南|页面|说明|费率|定价|接口)?/gi, " ")
    .replace(/(?:\bgoogle\b|\bgemini\b|谷歌)\s*(?:不是|并非|非)\s*(?:官方|official)/gi, " ")
    .replace(/\b(?:not|no|without)\s+(?:an?\s+)?(?:(?:google|gemini)\s+)?official\b/gi, " ")
    .replace(/\b(?:could not|cannot|can't|unable to|failed to|did not|does not|do not|can not)\s+(?:confirm|verify|validate|find)?\s*(?:(?:google|gemini)\s+)?official\b/gi, " ")
    .replace(/\b(?:not confirmed|unconfirmed|not verified)\s+(?:(?:google|gemini)\s+)?official\b/gi, " ")
    .replace(/\b(?:google|gemini)\s+(?:is\s+not|isn['’]t)\s+official\b/gi, " ")
    .replace(/\b(?:google|gemini)\s+official(?:\s+[a-z-]+){0,4}\s+(?:could not be|cannot be|was not|is not|has not been)\s+(?:confirmed|verified)\b/gi, " ");
}

function hasAffirmativeGoogleOfficialClaim(value: string): boolean {
  return /(?:\bgoogle\b|\bgemini\b|谷歌)(?:(?![。！？\n]).){0,40}(?:官方|\bofficial\b)/i.test(value)
    || /(?:官方|\bofficial\b)(?:(?![。！？\n]).){0,40}(?:\bgoogle\b|\bgemini\b|谷歌)/i.test(value);
}

function hasSourceOfficialStatement(value: string): boolean {
  return /官方\s*(?:文档|资料|原文|来源|模型|价格|指南|页面|说明|费率|定价|接口|帮助页|声明|公告|政策)/.test(value)
    || /官方\s*规则\s*(?:(?:已经|已|明确|文中|正文|中|具体|的|相关)\s*){0,3}(?:确认|规定|要求|指出|说明|列明)/.test(value)
    || /官方\s*规则\s*(?:中)?(?:对[^。！？\n]{0,120}?)?(?<![没未不])有明确(?:规定|说明|要求|确认)/.test(value)
    || /官方\s*规则\s*(?:已经|已)?\s*(?:写明|注明|载明)/.test(value)
    || /官方\s*规则\s*(?:已经|已)\s*明确/.test(value)
    || /\bofficial\s+(?:documentation|docs?|materials?|sources?|references?|models?|pricing|price|guides?|pages?|api|statements?|announcements?|policy|policies)\b/i.test(value)
    || /\bofficial\s+rules?\s+(?:confirm|require|state|specify|indicate|list)s?\b/i.test(value);
}

function hasGoogleOfficialClaim(title: string, content: string): boolean {
  const cleanTitle = cleanOfficialClaimNegations(title.replace(HTTP_URL_PATTERN, " "));
  const cleanContent = cleanOfficialClaimNegations(content.replace(HTTP_URL_PATTERN, " "));
  if (hasAffirmativeGoogleOfficialClaim(cleanTitle) || hasAffirmativeGoogleOfficialClaim(cleanContent)) return true;
  return /(?:\bgoogle\b|\bgemini\b|谷歌)/i.test(cleanTitle) && hasSourceOfficialStatement(cleanContent);
}

export async function prepareOfficialEvidence(
  title: string,
  content: string,
  dependencies: OfficialEvidenceDependencies = {},
): Promise<OfficialEvidenceResult> {
  const combined = `${title}\n${content}`;
  const models = extractGeminiModelIds(combined);
  const extractedUrls = extractHttpUrls(combined);
  const officialCandidates: string[] = [];
  let hasUnofficialUrl = false;

  for (const rawUrl of extractedUrls) {
    let hostname = "";
    try {
      hostname = new URL(rawUrl).hostname.toLowerCase();
    } catch {
      hostname = "";
    }
    if (OFFICIAL_HOSTNAMES.has(hostname) || isSuspiciousOfficialUrl(rawUrl)) officialCandidates.push(rawUrl);
    else hasUnofficialUrl = true;
  }

  const officialClaim = hasGoogleOfficialClaim(title, content);
  if (officialClaim && hasUnofficialUrl) {
    return { kind: "reject", reason: "Google/Gemini 官方声明不得使用非白名单来源" };
  }
  if (officialCandidates.length === 0) {
    if (officialClaim) return { kind: "reject", reason: "声称 Google/Gemini 官方但未提供白名单官方 URL" };
    return { kind: "none" };
  }

  try {
    const normalizedUrls = [...new Set(officialCandidates.map((url) => normalizeOfficialUrl(url)))];
    if (normalizedUrls.length > MAX_OFFICIAL_URLS) {
      return { kind: "reject", reason: `官方 URL 超过 ${MAX_OFFICIAL_URLS} 个，请拆分后送审` };
    }

    const fetchImpl = dependencies.fetchImpl || getDefaultOfficialFetch();
    const documents: OfficialDocument[] = [];
    for (const url of normalizedUrls) {
      documents.push(await fetchOfficialDocument(url, fetchImpl, dependencies.timeoutMs ?? OFFICIAL_FETCH_TIMEOUT_MS));
    }

    const fullText = documents.map((document) => document.text).join("\n");
    const unsupportedModel = models.find((model) => !containsExactModel(fullText, model));
    if (unsupportedModel) {
      return { kind: "reject", reason: `官方原文未精确支撑型号 ${unsupportedModel}` };
    }

    const sourceBudget = Math.min(MAX_SOURCE_EVIDENCE_CHARS, Math.floor(MAX_TOTAL_EVIDENCE_CHARS / documents.length));
    const sources: OfficialEvidenceSource[] = [];
    for (const document of documents) {
      const theme = getSourceTheme(document.url);
      const keywords = extractEvidenceKeywords(combined, document.url);
      const selection = selectEvidenceExcerpts(document.text, keywords, sourceBudget, {
        modelContextAfter: theme === "pricing" ? 1200 : 720,
        preferAfterAnchors: theme === "pricing",
      });
      if (!selection.text) return { kind: "reject", reason: "官方正文未覆盖知识关键词，无法核验" };
      if (
        theme === "pricing"
        && /input price/i.test(document.text)
        && /output price/i.test(document.text)
        && (!/input price/i.test(selection.text) || !/output price/i.test(selection.text))
      ) {
        return { kind: "reject", reason: "官方定价证据未完整覆盖 Input price/Output price，请拆分后送审" };
      }
      if (theme === "pricing") {
        const incompleteModel = findIncompletePricingModel(document.text, selection, models, combined);
        if (incompleteModel) {
          return { kind: "reject", reason: `官方定价证据未完整覆盖型号 ${incompleteModel} 的 Input price/Output price，请拆分后送审` };
        }
      }
      sources.push({ url: document.url, text: selection.text, coveredKeywords: selection.coveredKeywords });
    }

    const selectedText = sources.map((source) => source.text).join("\n");
    const omittedModel = models.find((model) => !containsExactModel(selectedText, model));
    if (omittedModel) {
      return { kind: "reject", reason: `有界证据无法完整覆盖型号 ${omittedModel}，请拆分后送审` };
    }
    return { kind: "ready", sources };
  } catch (error) {
    const reason = error instanceof OfficialSourceError ? error.message : "官方来源无法核验";
    return { kind: "reject", reason };
  }
}
