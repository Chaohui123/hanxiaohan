import { fetch, ProxyAgent, type RequestInit } from "undici";
import { getIamToken } from "./iam.js";

export type WordstatDevice = "all" | "desktop" | "phone" | "tablet";
export type WordstatPeriod = "daily" | "weekly" | "monthly";

export interface YandexCloudClientOptions {
  keyFile?: string;
  folderId?: string;
  proxyUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface WordstatTopRequest {
  phrase: string;
  regions?: Array<number | string>;
  devices?: WordstatDevice;
  limit?: number;
}

const DEVICE_MAP: Record<WordstatDevice, string> = {
  all: "DEVICE_ALL",
  desktop: "DEVICE_DESKTOP",
  phone: "DEVICE_PHONE",
  tablet: "DEVICE_TABLET",
};

export class YandexCloudError extends Error {
  constructor(message: string, readonly status: number, readonly service: string) {
    super(message);
    this.name = "YandexCloudError";
  }
}

function text(value: unknown, field: string, maximum = 5000): string {
  if (typeof value !== "string" || !value.trim() || value.length > maximum) throw new Error(`${field} must contain 1-${maximum} characters`);
  return value.trim();
}

function regions(values: Array<number | string> | undefined): string[] {
  const result = (values?.length ? values : [225]).map(String);
  if (result.some(value => !/^\d+$/.test(value))) throw new Error("Wordstat regions must contain numeric region IDs");
  return result;
}

function dateOnly(value: string, field: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${field} must be YYYY-MM-DD`);
  const parsed = new Date(`${value}T00:00:00Z`);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) throw new Error(`${field} must be a real calendar date`);
  return `${value}T00:00:00Z`;
}

function validateDynamicsDates(period: WordstatPeriod, fromDate: string, toDate?: string): void {
  if (toDate && fromDate > toDate) throw new Error("Wordstat fromDate must not be after toDate");
  if (period !== "monthly") return;
  if (fromDate.slice(8, 10) !== "01") throw new Error("Cloud Wordstat monthly fromDate must be the first day of the month");
  if (toDate) {
    const nextDay = new Date(`${toDate}T00:00:00Z`);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);
    if (nextDay.getUTCDate() !== 1) throw new Error("Cloud Wordstat monthly toDate must be the last day of the month");
  }
}

function xmlText(value: string): string {
  return value.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, "&").trim();
}

function searchResults(rawXml: string): Array<Record<string, unknown>> {
  return [...rawXml.matchAll(/<doc\b[^>]*>([\s\S]*?)<\/doc>/g)].map((match, index) => {
    const document = match[1];
    const field = (name: string) => xmlText(document.match(new RegExp(`<${name}>([\\s\\S]*?)<\\/${name}>`))?.[1] || "");
    return {
      position: index + 1,
      title: field("title"),
      url: field("url"),
      domain: field("domain"),
      snippet: [...document.matchAll(/<passage>([\s\S]*?)<\/passage>/g)].map(passage => xmlText(passage[1])).filter(Boolean).join(" "),
    };
  });
}

function audioChunks(value: unknown, chunks: string[] = []): string[] {
  if (Array.isArray(value)) {
    for (const item of value) audioChunks(item, chunks);
  } else if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    if (record.audioChunk && typeof record.audioChunk === "object") {
      const data = (record.audioChunk as Record<string, unknown>).data;
      if (typeof data === "string" && data) chunks.push(data);
    }
    for (const item of Object.values(record)) audioChunks(item, chunks);
  }
  return chunks;
}

export class YandexCloudClient {
  readonly keyFile?: string;
  readonly folderId: string;
  readonly proxyUrl?: string;
  readonly fetchImpl: typeof fetch;

  constructor(options: YandexCloudClientOptions = {}) {
    this.keyFile = options.keyFile;
    this.folderId = options.folderId || process.env.YANDEX_CLOUD_FOLDER_ID || "b1g7kg5sf3nob759onuo";
    this.proxyUrl = options.proxyUrl ?? process.env.YANDEX_CLOUD_PROXY_URL;
    this.fetchImpl = options.fetchImpl || fetch;
  }

  async post<T>(service: string, url: string, body: unknown): Promise<T> {
    const token = await getIamToken({ keyFile: this.keyFile, proxyUrl: this.proxyUrl, fetchImpl: this.fetchImpl });
    const dispatcher = this.proxyUrl ? new ProxyAgent(this.proxyUrl) : undefined;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "x-folder-id": this.folderId,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    const responseText = await response.text();
    if (response.status !== 200) throw new YandexCloudError(`${service} returned HTTP ${response.status}: ${responseText.slice(0, 800)}`, response.status, service);
    try {
      return JSON.parse(responseText) as T;
    } catch {
      return responseText as T;
    }
  }

  async synthesizeRussian(textValue: string): Promise<{ audio: Buffer; chunks: number; voice: "marina"; role: "friendly" }> {
    const speechText = text(textValue, "text");
    const response = await this.post<unknown>("SpeechKit", "https://tts.api.cloud.yandex.net:443/tts/v3/utteranceSynthesis", {
      text: speechText,
      hints: [{ voice: "marina" }, { role: "friendly" }],
    });
    let payload = response;
    if (typeof response === "string") {
      const lines = response.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      payload = lines.map(line => JSON.parse(line));
    }
    const chunks = audioChunks(payload);
    if (!chunks.length) throw new YandexCloudError("SpeechKit returned no audioChunk.data", 200, "SpeechKit");
    const buffers = chunks.map(chunk => {
      if (!/^[A-Za-z0-9+/=\r\n]+$/.test(chunk)) throw new YandexCloudError("SpeechKit returned invalid base64 audio", 200, "SpeechKit");
      return Buffer.from(chunk, "base64");
    });
    const audio = Buffer.concat(buffers);
    if (!audio.length) throw new YandexCloudError("SpeechKit returned empty audio", 200, "SpeechKit");
    return { audio, chunks: chunks.length, voice: "marina", role: "friendly" };
  }

  async wordstatTop(request: WordstatTopRequest): Promise<Record<string, unknown>> {
    const phrase = text(request.phrase, "phrase", 500);
    const limit = request.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > 2000) throw new Error("Wordstat limit must be an integer from 1 to 2000");
    return this.post("Wordstat", "https://searchapi.api.cloud.yandex.net/v2/wordstat/topRequests", {
      phrase,
      numPhrases: String(limit),
      regions: regions(request.regions),
      devices: [DEVICE_MAP[request.devices || "all"]],
      folderId: this.folderId,
    });
  }

  async wordstatDynamics(request: { phrase: string; period: WordstatPeriod; fromDate: string; toDate?: string; regions?: Array<number | string>; devices?: WordstatDevice }): Promise<Record<string, unknown>> {
    const phrase = text(request.phrase, "phrase", 500);
    if (!(["daily", "weekly", "monthly"] as string[]).includes(request.period)) throw new Error("Wordstat period must be daily, weekly or monthly");
    if (request.period !== "daily" && /(^|\s)[-!]\S|["()|]/.test(phrase)) {
      throw new Error("Cloud Wordstat weekly/monthly dynamics supports only the + operator; use daily for quotes, exact forms, minus words or groups");
    }
    const fromDate = dateOnly(request.fromDate, "fromDate");
    const toDate = request.toDate ? dateOnly(request.toDate, "toDate") : undefined;
    validateDynamicsDates(request.period, fromDate, toDate);
    return this.post("Wordstat", "https://searchapi.api.cloud.yandex.net/v2/wordstat/dynamics", {
      phrase,
      period: `PERIOD_${request.period.toUpperCase()}`,
      fromDate,
      ...(toDate ? { toDate } : {}),
      regions: regions(request.regions),
      devices: [DEVICE_MAP[request.devices || "all"]],
      folderId: this.folderId,
    });
  }

  async wordstatRegions(request: { phrase: string; regionType?: "all" | "cities" | "regions"; devices?: WordstatDevice }): Promise<Record<string, unknown>> {
    const regionType = request.regionType || "all";
    if (!(["all", "cities", "regions"] as string[]).includes(regionType)) throw new Error("Wordstat regionType must be all, cities or regions");
    return this.post("Wordstat", "https://searchapi.api.cloud.yandex.net/v2/wordstat/regions", {
      phrase: text(request.phrase, "phrase", 500),
      region: { all: "REGION_ALL", cities: "REGION_CITIES", regions: "REGION_REGIONS" }[regionType],
      devices: [DEVICE_MAP[request.devices || "all"]],
      folderId: this.folderId,
    });
  }

  async webSearch(request: { query: string; region?: number | string; results?: number; page?: number }): Promise<Record<string, unknown>> {
    const results = request.results ?? 10;
    const page = request.page ?? 0;
    if (!Number.isInteger(results) || results < 1 || results > 100) throw new Error("Search results must be an integer from 1 to 100");
    if (!Number.isInteger(page) || page < 0) throw new Error("Search page must be a non-negative integer");
    const region = String(request.region ?? 225);
    if (!/^\d+$/.test(region)) throw new Error("Search region must be a numeric region ID");
    const response = await this.post<Record<string, unknown>>("Yandex Search", "https://searchapi.api.cloud.yandex.net/v2/web/search", {
      query: {
        searchType: "SEARCH_TYPE_RU",
        queryText: text(request.query, "query", 500),
        familyMode: "FAMILY_MODE_MODERATE",
        fixTypoMode: "FIX_TYPO_MODE_ON",
        page,
      },
      sortSpec: {},
      groupSpec: { groupMode: "GROUP_MODE_FLAT", groupsOnPage: results, docsInGroup: 1 },
      maxPassages: 3,
      region,
      l10n: "LOCALIZATION_RU",
      folderId: this.folderId,
    });
    const rawData = response.rawData;
    if (typeof rawData !== "string" || !rawData) throw new YandexCloudError("Yandex Search returned no rawData", 200, "Yandex Search");
    const metadata = { ...response };
    delete metadata.rawData;
    const rawXml = Buffer.from(rawData, "base64").toString("utf8");
    return { ...metadata, rawXml, results: searchResults(rawXml) };
  }

  async translateToRussian(texts: string[], sourceLanguageCode = "zh"): Promise<Record<string, unknown>> {
    if (!Array.isArray(texts) || !texts.length || texts.length > 100) throw new Error("Translate texts must contain 1-100 items");
    const normalized = texts.map(value => text(value, "text"));
    return this.post("Translate", "https://translate.api.cloud.yandex.net/translate/v2/translate", {
      sourceLanguageCode,
      targetLanguageCode: "ru",
      texts: normalized,
      folderId: this.folderId,
    });
  }

  async recognizeText(image: Buffer, languages = ["zh", "en", "ru"]): Promise<Record<string, unknown>> {
    if (!Buffer.isBuffer(image) || !image.length) throw new Error("Vision image must be a non-empty Buffer");
    if (!languages.length || languages.some(value => !/^[a-z]{2}$/.test(value))) throw new Error("Vision languages must be ISO 639-1 codes");
    const response = await this.post<Record<string, unknown>>("Vision OCR", "https://vision.api.cloud.yandex.net/vision/v1/batchAnalyze", {
      folderId: this.folderId,
      analyze_specs: [{
        content: image.toString("base64"),
        features: [{ type: "TEXT_DETECTION", text_detection_config: { language_codes: languages } }],
      }],
    });
    const errors: string[] = [];
    const visit = (value: unknown) => {
      if (Array.isArray(value)) { value.forEach(visit); return; }
      if (!value || typeof value !== "object") return;
      const record = value as Record<string, unknown>;
      if (record.error && typeof record.error === "object") errors.push(JSON.stringify(record.error));
      Object.values(record).forEach(visit);
    };
    visit(response);
    if (errors.length) throw new YandexCloudError(`Vision OCR returned nested errors: ${errors.join(";").slice(0, 800)}`, 200, "Vision OCR");
    return response;
  }

  async recognizeRussianOggOpus(audio: Buffer): Promise<Record<string, unknown>> {
    if (!Buffer.isBuffer(audio) || !audio.length) throw new Error("STT audio must be a non-empty Buffer");
    if (audio.length > 1_000_000) throw new Error("Synchronous STT audio must not exceed 1 MB");
    const token = await getIamToken({ keyFile: this.keyFile, proxyUrl: this.proxyUrl, fetchImpl: this.fetchImpl });
    const dispatcher = this.proxyUrl ? new ProxyAgent(this.proxyUrl) : undefined;
    const url = `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize?lang=ru-RU&format=oggopus&folderId=${encodeURIComponent(this.folderId)}`;
    const response = await this.fetchImpl(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/octet-stream", "x-folder-id": this.folderId },
      body: audio,
      signal: AbortSignal.timeout(60_000),
      ...(dispatcher ? { dispatcher } : {}),
    } as RequestInit);
    const responseText = await response.text();
    if (response.status !== 200) throw new YandexCloudError(`SpeechKit STT returned HTTP ${response.status}: ${responseText.slice(0, 800)}`, response.status, "SpeechKit STT");
    const parsed = JSON.parse(responseText) as { result?: string };
    if (typeof parsed.result !== "string") throw new YandexCloudError("SpeechKit STT returned no result", 200, "SpeechKit STT");
    return parsed as Record<string, unknown>;
  }
}
