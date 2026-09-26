// ============================================================
// Daily Learning — 每日从公开平台学习跨境电商知识并沉淀到知识库
//
// 流水线（每日一次，scheduler 注册）：
//   源1 B 站：关键词搜索（wbi 签名）→ 近 96h 高播放视频 → CC 字幕/whisper 转录
//   源2 vc.ru：俄文电商标签 RSS（ozon/маркетплейсы/продвижение 等）→ 正文
//   源3 Reddit：r/ecommerce 等 sub 周榜（公开 JSON，score≥20）→ 英文电商经验
//   源4 俄文电商媒体 RSS：e-pepper.ru / retail.ru（标题关键词过滤）→ 俄文行业新闻
//   源5 Ozon seller-edu 官方教程（慢速爬取，fail-open）→ 权威平台规则
//   → DeepSeek 结构化提炼（关键词/搜索习惯/选品线索/主图视频实践/推广策略）
//   → Knowledge Gate 门禁（边界+真实性+语义查重）→ rag_operations_playbook
//   → 飞书推送学习简报（无论是否有新入库都发，2026-09-06 用户要求可见性）
//
// 设计原则：全自动无审批；防幻觉（只提取内容明确出现的知识）；幂等（sourceId 去重）；
//   token 防暴涨（蒸馏前 isAlreadyLearned 已学去重 + 每源每日蒸馏上限）；单源失败 fail-open。
// ============================================================

import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent } from "../services/notification-events.js";

// ---- 配置 ----

// B 站搜索词（2026-09-06 扩容 4→14：覆盖运营/选品/广告/内容/物流+我方赛道船配/冰钓；
// 2026-09-20 再扩 14→22：补破零/标签/搜索优化/流量/评价/冬季选品等高频痛点词）
const SEARCH_KEYWORDS = (process.env.LEARNING_BILI_KEYWORDS ||
  "Ozon运营,Ozon关键词,Ozon选品,Ozon广告,Ozon内容评级,跨境电商 俄罗斯,Yandex推广,俄罗斯电商,船外机维修,冰钓装备,冬钓装备,跨境物流 俄罗斯,Ozon卖家,跨境选品方法,Ozon破零,Ozon标签,Ozon搜索优化,Ozon流量,Ozon破零方法,跨境电商破零,俄罗斯冬季选品,Ozon评价"
).split(",").map((s) => s.trim()).filter(Boolean);
const MAX_VIDEOS_PER_KEYWORD = 2;

// vc.ru 俄文电商标签（RSS 直取，2026-09-06 新增俄文一手源；
// 2026-09-20 扩 4→8：补 продвижение/выдача/селлер/ecommerce 覆盖推广与搜索排名话题）
const VC_TAGS = (process.env.LEARNING_VC_TAGS || "ozon,маркетплейсы,wildberries,e-commerce,продвижение,выдача,селлер,ecommerce").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_VC_PER_TAG = 2;
const VC_RECENT_HOURS = parseInt(process.env.LEARNING_VC_RECENT_HOURS || "72", 10);

// 每源每日蒸馏上限（2026-09-20 token 防暴涨：各源每天最多发起 N 次 DeepSeek 蒸馏，
// 超出后该源后续条目直接跳过，零消耗；env LEARNING_DAILY_PER_SOURCE 可配）
const MAX_DISTILL_PER_SOURCE = parseInt(process.env.LEARNING_DAILY_PER_SOURCE || "5", 10);

// 跨境垂类新视频发布初期播放普遍几十（2026-09-05 实测：48h 内 Ozon 新视频播放 2-31）——
// 阈值 300 会把一切过滤掉；30 是质量与召回的平衡点
const MIN_PLAY_COUNT = parseInt(process.env.LEARNING_MIN_PLAY || "30", 10);
const RECENT_HOURS = parseInt(process.env.LEARNING_RECENT_HOURS || "96", 10); // 96h 窗口（4 天）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---- 统一学习条目（多源抽象） ----

interface LearningItem {
  /** 幂等键：B 站=bvid，vc.ru/媒体/seller-edu=文章 URL，Reddit=permalink（与 isAlreadyLearned 的 LIKE 查询兼容） */
  sourceId: string;
  source: "bilibili" | "vc.ru" | "reddit" | "habr" | "retail.ru" | "seller-edu";
  title: string;
  author: string;
  /** 正文/字幕（可为空，空则仅基于标题提炼并从严） */
  text: string;
  url: string;
  publishedAt: number; // 秒
  play?: number;       // 仅 B 站（whisper 门槛用）
}

// ---- B 站 wbi 签名（公开算法） ----

const MIXIN_KEY_TAB = [
  46, 47, 18, 2, 53, 8, 23, 32, 15, 50, 10, 31, 58, 3, 45, 35,
  27, 43, 5, 49, 33, 9, 42, 19, 29, 28, 14, 39, 12, 38, 41, 13,
  37, 48, 7, 16, 24, 55, 40, 61, 26, 17, 0, 1, 60, 51, 30, 4,
  22, 25, 54, 21, 56, 59, 6, 63, 57, 62, 11, 36, 20, 34, 44, 52,
];

let wbiKeysCache: { imgKey: string; subKey: string; fetchedAt: number } | null = null;

async function getWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  if (wbiKeysCache && Date.now() - wbiKeysCache.fetchedAt < 6 * 3600_000) return wbiKeysCache;
  const resp = await fetch("https://api.bilibili.com/x/web-interface/nav", {
    headers: { "User-Agent": UA, Referer: "https://www.bilibili.com" },
    signal: AbortSignal.timeout(10_000),
  });
  const data = await resp.json() as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
  const imgUrl = data.data?.wbi_img?.img_url || "";
  const subUrl = data.data?.wbi_img?.sub_url || "";
  const imgKey = imgUrl.split("/").pop()?.replace(".png", "") || "";
  const subKey = subUrl.split("/").pop()?.replace(".png", "") || "";
  if (!imgKey || !subKey) throw new Error("wbi keys unavailable");
  wbiKeysCache = { imgKey, subKey, fetchedAt: Date.now() };
  return wbiKeysCache;
}

function wbiSign(params: Record<string, string | number>, imgKey: string, subKey: string): Record<string, string | number> {
  const mixinKey = MIXIN_KEY_TAB.map((i) => (imgKey + subKey)[i]).join("").slice(0, 32);
  const withTs = { ...params, wts: Math.floor(Date.now() / 1000) };
  const sorted = Object.keys(withTs).sort();
  const query = sorted
    .map((k) => `${encodeURIComponent(k)}=${encodeURIComponent(String(withTs[k as keyof typeof withTs]).replace(/[!'()*]/g, ""))}`)
    .join("&");
  const wRid = crypto.createHash("md5").update(query + mixinKey).digest("hex");
  return { ...withTs, w_rid: wRid };
}

// ---- B 站搜索与字幕 ----

interface BiliVideo {
  bvid: string;
  title: string;
  description: string;
  play: number;
  pubdate: number;
  author: string;
  tag?: string;
}

async function searchBilibili(keyword: string): Promise<BiliVideo[]> {
  const { imgKey, subKey } = await getWbiKeys();
  const signed = wbiSign({ search_type: "video", keyword, order: "pubdate", page: 1, page_size: 10 }, imgKey, subKey);
  const qs = Object.entries(signed).map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
  const resp = await fetch(`https://api.bilibili.com/x/web-interface/wbi/search/type?${qs}`, {
    headers: { "User-Agent": UA, Referer: "https://search.bilibili.com" },
    signal: AbortSignal.timeout(15_000),
  });
  const data = await resp.json() as { code: number; data?: { result?: Array<Record<string, unknown>> } };
  if (data.code !== 0) {
    logger.warn({ keyword, code: data.code }, "Bilibili search failed");
    return [];
  }
  const cutoff = Date.now() / 1000 - RECENT_HOURS * 3600;
  return (data.data?.result || [])
    .filter((v) => v.type === "video")
    .map((v) => ({
      bvid: String(v.bvid || ""),
      title: String(v.title || "").replace(/<[^>]+>/g, ""),
      description: String(v.description || ""),
      play: Number(v.play) || 0,
      pubdate: Number(v.pubdate) || 0,
      author: String(v.author || ""),
      tag: String(v.tag || ""),
    }))
    .filter((v) => v.bvid && v.pubdate >= cutoff && v.play >= MIN_PLAY_COUNT)
    .slice(0, MAX_VIDEOS_PER_KEYWORD);
}

/** 拉 CC 字幕全文（无字幕轨返回空串） */
async function fetchSubtitleText(bvid: string): Promise<string> {
  try {
    // view API 拿 cid
    const viewResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
      headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000),
    });
    const viewData = await viewResp.json() as { data?: { cid?: number } };
    const cid = viewData.data?.cid;
    if (!cid) return "";

    const playerResp = await fetch(`https://api.bilibili.com/x/player/v2?bvid=${bvid}&cid=${cid}`, {
      headers: { "User-Agent": UA, Referer: `https://www.bilibili.com/video/${bvid}/` },
      signal: AbortSignal.timeout(10_000),
    });
    const playerData = await playerResp.json() as { data?: { subtitle?: { subtitles?: Array<{ subtitle_url?: string }> } } };
    const subUrl = playerData.data?.subtitle?.subtitles?.[0]?.subtitle_url;
    if (!subUrl) return "";

    const fullUrl = subUrl.startsWith("//") ? `https:${subUrl}` : subUrl;
    const subResp = await fetch(fullUrl, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
    const subData = await subResp.json() as { body?: Array<{ content?: string }> };
    const text = (subData.body || []).map((s) => s.content || "").join("\n");
    return text.slice(0, 6000); // 限长防 token 爆炸
  } catch (err) {
    logger.warn({ bvid, err: (err as Error).message }, "Subtitle fetch failed");
    return "";
  }
}

// ---- 无字幕视频 → whisper 转录（独立 whisper 服务容器） ----

const WHISPER_URL = process.env.WHISPER_URL || "http://whisper:9200";
/** 无字幕视频转录的热度门槛：≥50 播放才值得花 3-5 分钟 CPU 转录（2026-09-05 实测垂类分布） */
const TRANSCRIBE_MIN_PLAY = parseInt(process.env.LEARNING_TRANSCRIBE_MIN_PLAY || "50", 10);
const TRANSCRIBE_MAX_PER_KEYWORD = 1; // 每关键词最多转录 1 个（限流）

/** 取 B 站 dash 音频直链（playurl API, fnval=16） */
async function fetchAudioUrl(bvid: string): Promise<string> {
  const viewResp = await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(10_000),
  });
  const viewData = await viewResp.json() as { data?: { cid?: number } };
  const cid = viewData.data?.cid;
  if (!cid) return "";
  const playResp = await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&fnval=16&fourk=0`, {
    headers: { "User-Agent": UA, Referer: `https://www.bilibili.com/video/${bvid}/` },
    signal: AbortSignal.timeout(10_000),
  });
  const playData = await playResp.json() as { data?: { dash?: { audio?: Array<{ baseUrl?: string; base_url?: string }> } } };
  const audio = playData.data?.dash?.audio?.[0];
  return (audio?.baseUrl || audio?.base_url || "") as string;
}

/** 调 whisper 服务转录无字幕视频；服务不可用返回空串（降级回标题简介提炼） */
async function transcribeWithWhisper(video: BiliVideo): Promise<string> {
  try {
    const audioUrl = await fetchAudioUrl(video.bvid);
    if (!audioUrl) return "";
    const resp = await fetch(`${WHISPER_URL}/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ audioUrl, language: "zh", referer: "https://www.bilibili.com" }),
      signal: AbortSignal.timeout(420_000), // 9 分钟音频 CPU 约 3-5 分钟
    });
    if (!resp.ok) {
      logger.warn({ bvid: video.bvid, status: resp.status }, "Whisper service error");
      return "";
    }
    const data = await resp.json() as { text?: string; duration?: number };
    const text = (data.text || "").slice(0, 6000);
    logger.info({ bvid: video.bvid, duration: data.duration, chars: text.length }, "Whisper transcribed");
    return text;
  } catch (err) {
    logger.warn({ bvid: video.bvid, err: (err as Error).message }, "Whisper transcribe failed");
    return "";
  }
}

// ---- vc.ru 源（俄文电商标签 RSS） ----

/** 解析 RSS XML 为条目（轻量正则解析，content:encoded 优先于 description） */
export function parseRssItems(xml: string): Array<{ title: string; link: string; author: string; text: string; pubTs: number }> {
  const items: Array<{ title: string; link: string; author: string; text: string; pubTs: number }> = [];
  const blocks = xml.match(/<item>[\s\S]*?<\/item>/g) || [];
  const pick = (block: string, tag: string) => {
    const m = block.match(new RegExp(`<${tag}[^>]*>(?:<!\\[CDATA\\[)?([\\s\\S]*?)(?:\\]\\]>)?</${tag}>`));
    return (m?.[1] || "").trim();
  };
  const stripHtml = (s: string) => s.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  for (const b of blocks) {
    const title = stripHtml(pick(b, "title"));
    const link = pick(b, "link") || pick(b, "guid");
    const author = pick(b, "dc:creator") || pick(b, "author");
    const content = pick(b, "content:encoded") || pick(b, "description");
    const pubTs = Date.parse(pick(b, "pubDate")) / 1000 || 0;
    if (title && link) items.push({ title, link, author, text: stripHtml(content).slice(0, 6000), pubTs });
  }
  return items;
}

async function fetchVcRu(tag: string): Promise<LearningItem[]> {
  const resp = await fetch(`https://vc.ru/rss/tag/${encodeURIComponent(tag)}`, {
    headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    logger.warn({ tag, status: resp.status }, "vc.ru RSS fetch failed");
    return [];
  }
  const xml = await resp.text();
  const cutoff = Date.now() / 1000 - VC_RECENT_HOURS * 3600;
  return parseRssItems(xml)
    .filter((i) => i.pubTs >= cutoff)
    .slice(0, MAX_VC_PER_TAG)
    .map((i) => ({
      sourceId: i.link,
      source: "vc.ru" as const,
      title: i.title,
      author: i.author || "vc.ru",
      text: i.text,
      url: i.link,
      publishedAt: i.pubTs,
    }));
}

// ---- Reddit 源（英文电商经验，公开 JSON 无 key，2026-09-20 新增） ----

// 目标 sub：电商综合/创业经验/亚马逊 FBA（英文一手卖家经验，env 可覆盖）
const REDDIT_SUBS = (process.env.LEARNING_REDDIT_SUBS || "ecommerce,Entrepreneur,FulfillmentByAmazon").split(",").map((s) => s.trim()).filter(Boolean);
// 周榜热度门槛：score<20 的帖子多为水帖/求助帖，知识密度低
const REDDIT_MIN_SCORE = parseInt(process.env.LEARNING_REDDIT_MIN_SCORE || "20", 10);
const MAX_REDDIT_PER_SUB = 3;
// Reddit 拦默认 UA（返回 403/429），必须自定义带应用标识的 UA
const REDDIT_UA = "onzo:daily-learning:1.0 (cross-border ecommerce research bot)";

/** 解析 Reddit listing JSON 为学习条目（纯函数，便于单测） */
export function parseRedditPosts(json: string, minScore: number, maxPerSub: number): LearningItem[] {
  let data: { data?: { children?: Array<{ data?: Record<string, unknown> }> } };
  try {
    data = JSON.parse(json);
  } catch {
    return [];
  }
  const items: LearningItem[] = [];
  for (const c of data.data?.children || []) {
    const d = c.data || {};
    const score = Number(d.score) || 0;
    const permalink = String(d.permalink || "");
    const title = String(d.title || "").trim();
    if (!permalink || !title || score < minScore) continue;
    items.push({
      sourceId: permalink, // 幂等键：permalink 全站唯一（/r/<sub>/comments/<id>/...）
      source: "reddit",
      title,
      author: String(d.author || "reddit"),
      text: String(d.selftext || "").slice(0, 6000), // 限长防 token 爆炸
      url: `https://www.reddit.com${permalink}`,
      publishedAt: Number(d.created_utc) || 0,
    });
    if (items.length >= maxPerSub) break;
  }
  return items;
}

async function fetchRedditSub(sub: string): Promise<LearningItem[]> {
  const resp = await fetch(`https://www.reddit.com/r/${encodeURIComponent(sub)}/top.json?t=week&limit=15`, {
    headers: { "User-Agent": REDDIT_UA, Accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) {
    logger.warn({ sub, status: resp.status }, "Reddit fetch failed");
    return [];
  }
  return parseRedditPosts(await resp.text(), REDDIT_MIN_SCORE, MAX_REDDIT_PER_SUB);
}

// ---- 俄文电商媒体 RSS 源（e-pepper / retail.ru，2026-09-20 新增） ----

// feed 列表（retail.ru 主备两个路径，404 自动换备用）
const RU_MEDIA_FEEDS: Array<{ name: "habr" | "retail.ru"; urls: string[] }> = [
  // e-pepper.ru RSS 已失效（2026-09-26 实测 feed/rss/feed.xml 全 404）→ 换 Habr 俄文每日精选（电商/营销/创业内容多，RSS 稳定）
  { name: "habr", urls: ["https://habr.com/ru/rss/articles/top", "https://habr.com/ru/rss/all/all/"] },
  { name: "retail.ru", urls: ["https://www.retail.ru/rss/news/", "https://www.retail.ru/rss/"] },
];
// 标题关键词过滤：只留电商/平台运营相关，防泛零售新闻稀释知识库
const RU_MEDIA_KEYWORDS = (process.env.LEARNING_RU_MEDIA_KEYWORDS ||
  "ozon,маркетплейс,e-commerce,продвижение,выдача,селлер"
).split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
const MAX_RU_MEDIA_PER_FEED = 3;
const RU_MEDIA_RECENT_HOURS = parseInt(process.env.LEARNING_RU_MEDIA_RECENT_HOURS || "96", 10);

/** 标题是否命中电商关键词（纯函数，便于单测） */
export function isRuMediaRelevant(title: string): boolean {
  const t = title.toLowerCase();
  return RU_MEDIA_KEYWORDS.some((k) => t.includes(k));
}

async function fetchRuMedia(feed: { name: "habr" | "retail.ru"; urls: string[] }): Promise<LearningItem[]> {
  let xml = "";
  for (const url of feed.urls) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        logger.warn({ feed: feed.name, url, status: resp.status }, "RU media RSS fetch failed");
        continue; // 404 等 → 尝试备用路径
      }
      xml = await resp.text();
      break;
    } catch (err) {
      logger.warn({ feed: feed.name, url, err: (err as Error).message }, "RU media RSS fetch error");
    }
  }
  if (!xml) return [];
  const cutoff = Date.now() / 1000 - RU_MEDIA_RECENT_HOURS * 3600;
  return parseRssItems(xml) // 复用 vc.ru 的 RSS 解析（content:encoded 优先于 description）
    .filter((i) => (i.pubTs >= cutoff || i.pubTs === 0) && isRuMediaRelevant(i.title)) // 无日期的条目放行（slice 兜底限量）
    .slice(0, MAX_RU_MEDIA_PER_FEED)
    .map((i) => ({
      sourceId: i.link, // 幂等键：文章 URL
      source: feed.name,
      title: i.title,
      author: i.author || feed.name,
      text: i.text,
      url: i.link,
      publishedAt: i.pubTs,
    }));
}

// ---- Ozon seller-edu 官方教程源（权威平台规则，2026-09-20 新增） ----
// 反爬注意：自定义 UA + 慢速（1 req/2s）；整源 fail-open，爬不动返回空不影响其他源

const SELLER_EDU_ENABLED = (process.env.LEARNING_SELLER_EDU || "on") !== "off";
const SELLER_EDU_BASE = "https://seller-edu.ozon.ru";
const SELLER_EDU_LIST_URLS = [`${SELLER_EDU_BASE}/school`, `${SELLER_EDU_BASE}/`];
const MAX_SELLER_EDU_ARTICLES = parseInt(process.env.LEARNING_SELLER_EDU_MAX || "5", 10); // 每次最多爬 5 篇正文（控制时长）
const SELLER_EDU_REQ_INTERVAL = 2000; // 慢速：请求间隔 2s

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 从列表页 HTML 提取教程链接（纯函数，便于单测；同域+去静态资源+去重归一化） */
export function extractSellerEduLinks(html: string, baseUrl: string = SELLER_EDU_BASE): string[] {
  const links = new Set<string>();
  const re = /href="([^"]+)"/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    let href = m[1].trim();
    if (href.startsWith("/")) href = baseUrl + href;
    if (!href.startsWith(baseUrl)) continue; // 只要同域
    const path = href.slice(baseUrl.length).split(/[?#]/)[0];
    // 排除首页/锚点/静态资源/过短路径（教程链接路径一般较长）
    if (path.length < 4 || path === "/") continue;
    if (/\.(css|js|mjs|png|jpe?g|gif|svg|ico|webp|woff2?|ttf|json|xml|txt|pdf)(\?|$)/i.test(path)) continue;
    links.add(baseUrl + path);
  }
  return Array.from(links);
}

/** 从正文页 HTML 提取标题与纯文本（纯函数，便于单测；去 script/style/标签/实体） */
export function extractSellerEduArticle(html: string): { title: string; text: string } {
  const strip = (s: string) =>
    s
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, " ")
      .trim();
  const h1 = html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const titleTag = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const title = strip(h1?.[1] || titleTag?.[1] || "");
  return { title, text: strip(html).slice(0, 6000) }; // 限长防 token 爆炸
}

/** 爬列表页拿教程链接（两个入口依次尝试，SPA 渲染失败返回空 → fail-open） */
async function fetchSellerEduLinks(): Promise<string[]> {
  for (const url of SELLER_EDU_LIST_URLS) {
    try {
      const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        logger.warn({ url, status: resp.status }, "seller-edu list fetch failed");
        continue;
      }
      const links = extractSellerEduLinks(await resp.text());
      if (links.length > 0) return links;
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, "seller-edu list fetch error");
    }
  }
  return [];
}

/** 整源采集：列表 → 慢速逐篇抓正文（1 req/2s）→ LearningItem；任何一步失败返回已采到的部分 */
async function fetchSellerEdu(): Promise<LearningItem[]> {
  if (!SELLER_EDU_ENABLED) return [];
  const links = await fetchSellerEduLinks();
  if (links.length === 0) {
    logger.warn("seller-edu: 列表页未提取到链接（可能被反爬或为 SPA），本周期跳过该源");
    return [];
  }
  const items: LearningItem[] = [];
  for (const url of links.slice(0, MAX_SELLER_EDU_ARTICLES * 2)) { // 多取一倍候选，正文太短的跳过
    if (items.length >= MAX_SELLER_EDU_ARTICLES) break;
    try {
      await sleep(SELLER_EDU_REQ_INTERVAL); // 慢速防反爬
      const resp = await fetch(url, { headers: { "User-Agent": UA }, signal: AbortSignal.timeout(15_000) });
      if (!resp.ok) {
        logger.warn({ url, status: resp.status }, "seller-edu article fetch failed");
        continue;
      }
      const { title, text } = extractSellerEduArticle(await resp.text());
      if (!title || text.length < 500) continue; // 正文太短=无效页（导航页/SPA 空壳）
      items.push({
        sourceId: url, // 幂等键：文章 URL
        source: "seller-edu",
        title,
        author: "Ozon seller-edu",
        text,
        url,
        publishedAt: Math.floor(Date.now() / 1000), // 教程页无发布时间，用采集时间
      });
    } catch (err) {
      logger.warn({ url, err: (err as Error).message }, "seller-edu article fetch error");
    }
  }
  return items;
}

// ---- DeepSeek 结构化提炼 ----

interface DistilledKnowledge {
  keywords: Array<{ ru: string; zh: string }>;
  searchHabits: string[];
  productClues: string[];
  contentPractices: string[];
  promoStrategies: string[];
  summary: string;
}

const DISTILL_PROMPT = `你是 Ozon 跨境电商运营专家。从下面的学习内容中提取可落地的知识，严格 JSON 输出。
内容可能是中文、俄文或英文（俄文为俄罗斯本土卖家/媒体一手经验，英文为 Reddit 等国际电商社区经验，均有价值）；你的输出中 keywords 必须是俄语搜索词，summary 用中文。

要求：
1. 只提取内容中**明确出现**的知识点，严禁编造/推测（无相关内容则对应数组留空）
2. keywords: 俄语搜索词/关键词，附中文释义（这是俄罗斯买家真实搜索用词，价值最高）
3. searchHabits: 俄罗斯用户搜索习惯洞察
4. productClues: 选品线索（具体品类/商品/需求点）
5. contentPractices: 主图/视频/详情页的内容制作实践
6. promoStrategies: 推广/广告投放策略
7. summary: 100 字内中文摘要

JSON 结构：{"keywords":[{"ru":"...","zh":"..."}],"searchHabits":["..."],"productClues":["..."],"contentPractices":["..."],"promoStrategies":["..."],"summary":"..."}`;

async function distillWithDeepSeek(item: LearningItem): Promise<DistilledKnowledge | null> {
  if (!DEEPSEEK_API_KEY) return null;
  const content = `来源：${item.source}\n标题：${item.title}\n作者/UP主：${item.author}\n链接：${item.url}\n${item.text ? `正文/字幕：\n${item.text}` : "（无正文，仅基于标题提炼，请从严）"}`;
  try {
    const resp = await fetch(`${DEEPSEEK_BASE}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${DEEPSEEK_API_KEY}` },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: DISTILL_PROMPT },
          { role: "user", content },
        ],
        temperature: 0.3,
        max_tokens: 2000,
      }),
      signal: AbortSignal.timeout(60_000),
    });
    const data = (await resp.json()) as { choices?: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content || "";
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]) as DistilledKnowledge;
    if (!parsed.summary) return null;
    return {
      keywords: Array.isArray(parsed.keywords) ? parsed.keywords : [],
      searchHabits: Array.isArray(parsed.searchHabits) ? parsed.searchHabits : [],
      productClues: Array.isArray(parsed.productClues) ? parsed.productClues : [],
      contentPractices: Array.isArray(parsed.contentPractices) ? parsed.contentPractices : [],
      promoStrategies: Array.isArray(parsed.promoStrategies) ? parsed.promoStrategies : [],
      summary: String(parsed.summary),
    };
  } catch (err) {
    logger.error({ sourceId: item.sourceId, err: (err as Error).message }, "DeepSeek distill failed");
    return null;
  }
}

// ---- 入库（向量知识库，经 Knowledge Gate 门禁：边界+真实性+语义查重） ----

type SaveResult = "saved" | "dup" | "gated" | "error";

/** 已学条目检查（与 saveToPlaybook 同查询）——蒸馏【前】调用，已入库条目零 DeepSeek 消耗（2026-09-20 token 节流） */
async function isAlreadyLearned(sourceId: string): Promise<boolean> {
  const db = await getDb().catch(() => null);
  if (!db) return false; // fail-open：DB 不可用不拦学习
  const dup = await db.all<{ x: number }>(
    "SELECT 1 AS x FROM rag_operations_playbook WHERE content LIKE ? LIMIT 1",
    [`%${sourceId}%`],
  ).catch(() => [] as Array<{ x: number }>);
  return dup.length > 0;
}

// 各来源的入库展示标签（简报与知识库 content 第一行共用口径）
const SOURCE_LABELS: Record<LearningItem["source"], string> = {
  bilibili: "B站",
  "vc.ru": "vc.ru(俄文)",
  reddit: "Reddit(英文)",
  habr: "Habr(俄文)",
  "retail.ru": "retail.ru(俄文)",
  "seller-edu": "Ozon官方教程(俄文)",
};

/** 知识库条目 id：B 站直接用 bvid；其余源用 源前缀+sourceId base64url 尾段（vc.ru 保持既有 learn_vc_ 前缀不变） */
function makeEntryId(item: LearningItem): string {
  if (item.source === "bilibili") return `learn_${item.sourceId}`;
  const prefix = item.source === "vc.ru" ? "learn_vc" : `learn_${item.source.replace(/[^a-z0-9]/g, "")}`;
  return `${prefix}_${Buffer.from(item.sourceId).toString("base64url").slice(-24)}`;
}

async function saveToPlaybook(item: LearningItem, k: DistilledKnowledge): Promise<SaveResult> {
  const db = await getDb().catch(() => null);
  if (!db) return "error";

  // 幂等：sourceId 已在库则跳过
  const dup = await db.all<{ x: number }>(
    "SELECT 1 AS x FROM rag_operations_playbook WHERE content LIKE ? LIMIT 1",
    [`%${item.sourceId}%`],
  ).catch(() => [] as Array<{ x: number }>);
  if (dup.length > 0) return "dup";

  const content = [
    `来源：${SOURCE_LABELS[item.source]}《${item.title}》作者:${item.author}（${item.sourceId}）`,
    `摘要：${k.summary}`,
    k.searchHabits.length ? `搜索习惯：${k.searchHabits.join("；")}` : "",
    k.productClues.length ? `选品线索：${k.productClues.join("；")}` : "",
    k.contentPractices.length ? `内容实践：${k.contentPractices.join("；")}` : "",
    k.promoStrategies.length ? `推广策略：${k.promoStrategies.join("；")}` : "",
    k.keywords.length ? `关键词：${k.keywords.map((w) => `${w.ru}(${w.zh})`).join("、")}` : "",
  ].filter(Boolean).join("\n");

  try {
    const { knowledgeGate, persistToPlaybook } = await import("../services/knowledge-gate.js");
    const input = {
      id: makeEntryId(item),
      title: `每日学习: ${item.title}`.slice(0, 120),
      scenario: "learning",
      content,
      tags: ["每日学习", item.source, ...k.keywords.slice(0, 5).map((w) => w.ru)],
      author: "daily-learning",
      priority: 1,
    };
    const gate = await knowledgeGate(input);
    if (gate.action === "reject" || gate.action === "skip") {
      logger.info({ sourceId: item.sourceId, action: gate.action, reason: gate.reason }, "DailyLearning: gated out");
      return "gated";
    }
    return (await persistToPlaybook(input, gate)) ? "saved" : "error";
  } catch (err) {
    logger.error({ sourceId: item.sourceId, err: (err as Error).message }, "Playbook insert failed");
    return "error";
  }
}

// ---- 新源通用处理 ----

/** 处理上下文：跨源共享 seen 去重、统计、简报标题、关键词集合、每源蒸馏计数 */
interface ProcessCtx {
  seen: Set<string>;
  stats: LearningStats;
  learnedTitles: string[];
  allKeywords: Set<string>;
  /** 每源今日已发起蒸馏次数（LEARNING_DAILY_PER_SOURCE 上限控制，token 防暴涨） */
  distilledPerSource: Record<string, number>;
}

/** 每源每日蒸馏上限检查（发起蒸馏前调用；超限零消耗直接跳过） */
function hasDistillBudget(ctx: ProcessCtx, source: string): boolean {
  return (ctx.distilledPerSource[source] || 0) < MAX_DISTILL_PER_SOURCE;
}

/** 记一次蒸馏消耗（无论蒸馏成败都算，防失败重试烧 token） */
function noteDistill(ctx: ProcessCtx, source: string): void {
  ctx.distilledPerSource[source] = (ctx.distilledPerSource[source] || 0) + 1;
}

/**
 * 新源（Reddit/俄文媒体/seller-edu）统一处理流水线：
 * seen 去重 → 蒸馏前 isAlreadyLearned 已学去重（零 DeepSeek 消耗）
 * → 每源每日蒸馏上限 → DeepSeek 蒸馏 → Knowledge Gate 入库
 */
async function processLearningItems(items: LearningItem[], ctx: ProcessCtx, titlePrefix: string): Promise<void> {
  for (const item of items) {
    if (ctx.seen.has(item.sourceId)) continue;
    ctx.seen.add(item.sourceId);

    // 蒸馏前已学去重（2026-09-20 token 节流）
    if (await isAlreadyLearned(item.sourceId)) { ctx.stats.dup++; continue; }

    // 每源每日蒸馏上限（token 防暴涨）：超限后该源后续条目全部跳过
    if (!hasDistillBudget(ctx, item.source)) continue;

    ctx.stats.scanned++;
    ctx.stats.bySource[item.source] = (ctx.stats.bySource[item.source] || 0) + 1;
    noteDistill(ctx, item.source);

    const knowledge = await distillWithDeepSeek(item);
    if (!knowledge) continue;

    const r = await saveToPlaybook(item, knowledge);
    if (r === "saved") {
      ctx.stats.learned++;
      ctx.learnedTitles.push(`${titlePrefix}${item.title}`);
      for (const w of knowledge.keywords) ctx.allKeywords.add(`${w.ru}(${w.zh})`);
    } else if (r === "gated") ctx.stats.gated++;
    else if (r === "dup") ctx.stats.dup++;
  }
}

// ---- 主流程 ----

export interface LearningStats {
  scanned: number;
  learned: number;
  newKeywords: number;
  gated: number;
  dup: number;
  bySource: Record<string, number>;
}

export async function runDailyLearning(): Promise<LearningStats> {
  const stats: LearningStats = { scanned: 0, learned: 0, newKeywords: 0, gated: 0, dup: 0, bySource: {} };

  // 每日一次守卫（2026-09-19 用户要求）：部署重建会触发调度器首跑导致一天跑多次——
  // 用 PG 记录上次完成时间，距今 <20h 则跳过（容器随便重建也不重复跑）
  try {
    const db = await getDb().catch(() => null);
    if (db) {
      await db.run("CREATE TABLE IF NOT EXISTS job_run_log (job_name text PRIMARY KEY, last_run timestamptz NOT NULL)").catch(() => {});
      const rows = await db.all<{ last_run: string }>(
        "SELECT last_run FROM job_run_log WHERE job_name = 'daily-learning'",
      ).catch(() => [] as Array<{ last_run: string }>);
      const lastRun = rows[0]?.last_run ? new Date(rows[0].last_run).getTime() : 0;
      if (Date.now() - lastRun < 20 * 3600_000) {
        logger.info({ lastRun: rows[0]?.last_run }, "DailyLearning: 今日已跑过，跳过（部署重建首跑守卫）");
        return stats;
      }
    }
  } catch (err) {
    logger.warn({ err: (err as Error).message }, "DailyLearning: run-guard check failed (fail-open)");
  }

  const seen = new Set<string>();
  const learnedTitles: string[] = [];
  const allKeywords = new Set<string>();
  // 新源处理上下文（B 站/vc.ru 沿用既有内联循环，仅接入蒸馏预算检查；采集逻辑不动）
  const ctx: ProcessCtx = { seen, stats, learnedTitles, allKeywords, distilledPerSource: {} };

  // ---- 源 1：B 站（中文跨境教学） ----
  for (const kw of SEARCH_KEYWORDS) {
    // 每源每日蒸馏上限：用完后跳过后续关键词（不拉字幕/whisper，零消耗）
    if (!hasDistillBudget(ctx, "bilibili")) break;
    let videos: BiliVideo[] = [];
    try {
      videos = await searchBilibili(kw);
    } catch (err) {
      logger.error({ kw, err: (err as Error).message }, "DailyLearning: search failed");
      continue;
    }

    let transcribed = 0; // 每关键词 whisper 转录计数（限流）
    for (const video of videos) {
      if (seen.has(video.bvid)) continue;
      seen.add(video.bvid);

      // 蒸馏前已学去重（2026-09-20 token 节流）：已入库条目跳过字幕拉取/whisper/DeepSeek 全流程
      if (await isAlreadyLearned(video.bvid)) { stats.dup++; continue; }

      // 每源每日蒸馏上限（在字幕拉取/whisper 之前拦截，超限零消耗）
      if (!hasDistillBudget(ctx, "bilibili")) break;

      stats.scanned++;
      stats.bySource.bilibili = (stats.bySource.bilibili || 0) + 1;
      noteDistill(ctx, "bilibili");

      let subtitle = await fetchSubtitleText(video.bvid);

      // 无字幕高价值视频 → whisper 转录（播放≥50 才值得 CPU 成本，每关键词限 1 个）
      if (!subtitle && video.play >= TRANSCRIBE_MIN_PLAY && transcribed < TRANSCRIBE_MAX_PER_KEYWORD) {
        subtitle = await transcribeWithWhisper(video);
        if (subtitle) transcribed++;
      }

      const item: LearningItem = {
        sourceId: video.bvid, source: "bilibili",
        title: video.title, author: video.author,
        text: subtitle || [video.description, video.tag].filter(Boolean).join("\n标签："),
        url: `https://www.bilibili.com/video/${video.bvid}/`,
        publishedAt: video.pubdate, play: video.play,
      };
      const knowledge = await distillWithDeepSeek(item);
      if (!knowledge) continue;

      const r = await saveToPlaybook(item, knowledge);
      if (r === "saved") {
        stats.learned++;
        learnedTitles.push(video.title);
        for (const w of knowledge.keywords) allKeywords.add(`${w.ru}(${w.zh})`);
      } else if (r === "gated") stats.gated++;
      else if (r === "dup") stats.dup++;
    }
  }

  // ---- 源 2：vc.ru（俄文一手电商经验） ----
  for (const tag of VC_TAGS) {
    // 每源每日蒸馏上限：用完后跳过后续标签
    if (!hasDistillBudget(ctx, "vc.ru")) break;
    let items: LearningItem[] = [];
    try {
      items = await fetchVcRu(tag);
    } catch (err) {
      logger.error({ tag, err: (err as Error).message }, "DailyLearning: vc.ru fetch failed");
      continue;
    }
    for (const item of items) {
      if (seen.has(item.sourceId)) continue;
      seen.add(item.sourceId);

      // 蒸馏前已学去重（2026-09-20 token 节流）
      if (await isAlreadyLearned(item.sourceId)) { stats.dup++; continue; }

      // 每源每日蒸馏上限（token 防暴涨）
      if (!hasDistillBudget(ctx, "vc.ru")) break;

      stats.scanned++;
      stats.bySource["vc.ru"] = (stats.bySource["vc.ru"] || 0) + 1;
      noteDistill(ctx, "vc.ru");

      const knowledge = await distillWithDeepSeek(item);
      if (!knowledge) continue;

      const r = await saveToPlaybook(item, knowledge);
      if (r === "saved") {
        stats.learned++;
        learnedTitles.push(`[俄] ${item.title}`);
        for (const w of knowledge.keywords) allKeywords.add(`${w.ru}(${w.zh})`);
      } else if (r === "gated") stats.gated++;
      else if (r === "dup") stats.dup++;
    }
  }

  // ---- 源 3：Reddit（英文电商经验，r/ecommerce 等周榜，2026-09-20 新增） ----
  for (const sub of REDDIT_SUBS) {
    // 每源每日蒸馏上限：用完后跳过后续 sub
    if (!hasDistillBudget(ctx, "reddit")) break;
    let items: LearningItem[] = [];
    try {
      items = await fetchRedditSub(sub);
    } catch (err) {
      // fail-open：单 sub 失败不影响其他 sub/其他源
      logger.error({ sub, err: (err as Error).message }, "DailyLearning: reddit fetch failed");
      continue;
    }
    await processLearningItems(items, ctx, "[Reddit] ");
  }

  // ---- 源 4：俄文电商媒体 RSS（e-pepper / retail.ru，2026-09-20 新增） ----
  for (const feed of RU_MEDIA_FEEDS) {
    // 每源每日蒸馏上限（各媒体独立计数）：用完后跳过该媒体
    if (!hasDistillBudget(ctx, feed.name)) continue;
    let items: LearningItem[] = [];
    try {
      items = await fetchRuMedia(feed);
    } catch (err) {
      // fail-open：单媒体失败不影响其他媒体/其他源
      logger.error({ feed: feed.name, err: (err as Error).message }, "DailyLearning: RU media fetch failed");
      continue;
    }
    await processLearningItems(items, ctx, "[俄] ");
  }

  // ---- 源 5：Ozon seller-edu 官方教程（权威，慢速爬取，2026-09-20 新增） ----
  if (hasDistillBudget(ctx, "seller-edu")) {
    try {
      const items = await fetchSellerEdu(); // 整源 fail-open：爬不动返回空数组
      await processLearningItems(items, ctx, "[官方] ");
    } catch (err) {
      logger.error({ err: (err as Error).message }, "DailyLearning: seller-edu fetch failed");
    }
  }

  stats.newKeywords = allKeywords.size;

  // 飞书简报：无论是否有新入库都发（2026-09-06 用户要求——静默运行导致"没有启动"的误判）
  const sourcesStr = Object.entries(stats.bySource).map(([k, v]) => `${k}:${v}`).join(" ");
  await emitEvent("DAILY_LEARNING", {
    scanned: String(stats.scanned),
    learned: String(stats.learned),
    keywords: String(stats.newKeywords),
    sources: sourcesStr,
    gated: String(stats.gated),
    dup: String(stats.dup),
    titles: learnedTitles.slice(0, 3).join("；").slice(0, 200) || "（无新内容入库）",
    topKeywords: Array.from(allKeywords).slice(0, 8).join("、").slice(0, 200),
  }).catch(() => {});

  logger.info(stats, "DailyLearning: cycle complete");

  // 更新运行时间（每日一次守卫）
  try {
    const db = await getDb().catch(() => null);
    if (db) {
      await db.run(
        "INSERT INTO job_run_log (job_name, last_run) VALUES ('daily-learning', NOW()) ON CONFLICT (job_name) DO UPDATE SET last_run = NOW()",
      ).catch(() => {});
    }
  } catch { /* best effort */ }
  return stats;
}

// 手动触发入口（/api/task/run-learning）
export { runDailyLearning as default };
