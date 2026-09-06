// ============================================================
// Daily Learning — 每日从公开平台学习跨境电商知识并沉淀到知识库
//
// 流水线（每日一次，scheduler 注册）：
//   源1 B 站：关键词搜索（wbi 签名）→ 近 96h 高播放视频 → CC 字幕/whisper 转录
//   源2 vc.ru：俄文电商标签 RSS（ozon/маркетплейсы/wildberries/e-commerce）→ 正文
//   → DeepSeek 结构化提炼（关键词/搜索习惯/选品线索/主图视频实践/推广策略）
//   → Knowledge Gate 门禁（边界+真实性+语义查重）→ rag_operations_playbook
//   → 飞书推送学习简报（无论是否有新入库都发，2026-09-06 用户要求可见性）
//
// 设计原则：全自动无审批；防幻觉（只提取内容明确出现的知识）；幂等（sourceId 去重）。
// ============================================================

import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent } from "../services/notification-events.js";

// ---- 配置 ----

// B 站搜索词（2026-09-06 扩容 4→14：覆盖运营/选品/广告/内容/物流+我方赛道船配/冰钓）
const SEARCH_KEYWORDS = (process.env.LEARNING_BILI_KEYWORDS ||
  "Ozon运营,Ozon关键词,Ozon选品,Ozon广告,Ozon内容评级,跨境电商 俄罗斯,Yandex推广,俄罗斯电商,船外机维修,冰钓装备,冬钓装备,跨境物流 俄罗斯,Ozon卖家,跨境选品方法"
).split(",").map((s) => s.trim()).filter(Boolean);
const MAX_VIDEOS_PER_KEYWORD = 2;

// vc.ru 俄文电商标签（RSS 直取，2026-09-06 新增俄文一手源）
const VC_TAGS = (process.env.LEARNING_VC_TAGS || "ozon,маркетплейсы,wildberries,e-commerce").split(",").map((s) => s.trim()).filter(Boolean);
const MAX_VC_PER_TAG = 2;
const VC_RECENT_HOURS = parseInt(process.env.LEARNING_VC_RECENT_HOURS || "72", 10);

// 跨境垂类新视频发布初期播放普遍几十（2026-09-05 实测：48h 内 Ozon 新视频播放 2-31）——
// 阈值 300 会把一切过滤掉；30 是质量与召回的平衡点
const MIN_PLAY_COUNT = parseInt(process.env.LEARNING_MIN_PLAY || "30", 10);
const RECENT_HOURS = parseInt(process.env.LEARNING_RECENT_HOURS || "96", 10); // 96h 窗口（4 天）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

// ---- 统一学习条目（多源抽象） ----

interface LearningItem {
  /** 幂等键：B 站=bvid，vc.ru=文章 URL */
  sourceId: string;
  source: "bilibili" | "vc.ru";
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
内容可能是中文或俄文（俄文为俄罗斯本土卖家/媒体一手经验，价值最高）；你的输出中 keywords 必须是俄语搜索词，summary 用中文。

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
    `来源：${item.source === "bilibili" ? "B站" : "vc.ru(俄文)"}《${item.title}》作者:${item.author}（${item.sourceId}）`,
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
      id: item.source === "bilibili" ? `learn_${item.sourceId}` : `learn_vc_${Buffer.from(item.sourceId).toString("base64url").slice(-24)}`,
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
  const seen = new Set<string>();
  const learnedTitles: string[] = [];
  const allKeywords = new Set<string>();

  // ---- 源 1：B 站（中文跨境教学） ----
  for (const kw of SEARCH_KEYWORDS) {
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
      stats.scanned++;
      stats.bySource.bilibili = (stats.bySource.bilibili || 0) + 1;

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
      stats.scanned++;
      stats.bySource["vc.ru"] = (stats.bySource["vc.ru"] || 0) + 1;

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
  return stats;
}

// 手动触发入口（/api/task/run-learning）
export { runDailyLearning as default };
