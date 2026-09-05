// ============================================================
// Daily Learning — 每日从公开网站学习跨境电商知识并沉淀到知识库
//
// 流水线（每日 03:30）：
//   B 站关键词搜索（wbi 签名）→ 近 48h 高播放视频 → CC 字幕提取
//   → DeepSeek 结构化提炼（关键词/搜索习惯/选品线索/主图视频实践/推广策略）
//   → 写入 rag_operations_playbook（向量检索，供选品/文案/调价引用）
//   → 飞书推送学习摘要
//
// 设计原则：全自动无审批；防幻觉（只提取内容明确出现的知识）；幂等（bvid 去重）。
// ============================================================

import crypto from "node:crypto";
import { getDb } from "../db/connection.js";
import { logger } from "@onzo/logger";
import { emitEvent } from "../services/notification-events.js";

// ---- 配置 ----

const SEARCH_KEYWORDS = (process.env.LEARNING_BILI_KEYWORDS || "Ozon运营,Ozon关键词,跨境电商 俄罗斯,Yandex推广").split(",");
const MAX_VIDEOS_PER_KEYWORD = 2;
// 跨境垂类新视频发布初期播放普遍几十（2026-09-05 实测：48h 内 Ozon 新视频播放 2-31）——
// 阈值 300 会把一切过滤掉；30 是质量与召回的平衡点
const MIN_PLAY_COUNT = parseInt(process.env.LEARNING_MIN_PLAY || "30", 10);
const RECENT_HOURS = parseInt(process.env.LEARNING_RECENT_HOURS || "96", 10); // 96h 窗口（4 天）
const DEEPSEEK_API_KEY = process.env.DEEPSEEK_API_KEY || "";
const DEEPSEEK_BASE = process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com";

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

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

要求：
1. 只提取内容中**明确出现**的知识点，严禁编造/推测（无相关内容则对应数组留空）
2. keywords: 俄语搜索词/关键词，附中文释义（这是俄罗斯买家真实搜索用词，价值最高）
3. searchHabits: 俄罗斯用户搜索习惯洞察
4. productClues: 选品线索（具体品类/商品/需求点）
5. contentPractices: 主图/视频/详情页的内容制作实践
6. promoStrategies: 推广/广告投放策略
7. summary: 100 字内中文摘要

JSON 结构：{"keywords":[{"ru":"...","zh":"..."}],"searchHabits":["..."],"productClues":["..."],"contentPractices":["..."],"promoStrategies":["..."],"summary":"..."}`;

async function distillWithDeepSeek(video: BiliVideo, subtitle: string): Promise<DistilledKnowledge | null> {
  if (!DEEPSEEK_API_KEY) return null;
  const content = `标题：${video.title}\nUP主：${video.author}\n简介：${video.description || "无"}\n标签：${video.tag || "无"}\n${subtitle ? `字幕全文：\n${subtitle}` : "（无字幕，仅基于标题简介提炼，请从严）"}`;
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
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
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
    logger.error({ bvid: video.bvid, err: (err as Error).message }, "DeepSeek distill failed");
    return null;
  }
}

// ---- 入库（向量知识库，经 Knowledge Gate 门禁：边界+真实性+语义查重） ----

async function saveToPlaybook(video: BiliVideo, k: DistilledKnowledge): Promise<boolean> {
  const db = await getDb().catch(() => null);
  if (!db) return false;

  // 幂等：bvid 已在库则跳过
  const dup = await db.all<{ x: number }>(
    "SELECT 1 AS x FROM rag_operations_playbook WHERE content LIKE ? LIMIT 1",
    [`%${video.bvid}%`],
  ).catch(() => [] as Array<{ x: number }>);
  if (dup.length > 0) return false;

  const content = [
    `来源：B站《${video.title}》UP主:${video.author} (${video.bvid})`,
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
      id: `learn_${video.bvid}`,
      title: `每日学习: ${video.title}`.slice(0, 120),
      scenario: "learning",
      content,
      tags: ["每日学习", "B站", ...k.keywords.slice(0, 5).map((w) => w.ru)],
      author: "daily-learning",
      priority: 1,
    };
    const gate = await knowledgeGate(input);
    if (gate.action === "reject" || gate.action === "skip") {
      logger.info({ bvid: video.bvid, action: gate.action, reason: gate.reason }, "DailyLearning: gated out");
      return false;
    }
    return await persistToPlaybook(input, gate);
  } catch (err) {
    logger.error({ bvid: video.bvid, err: (err as Error).message }, "Playbook insert failed");
    return false;
  }
}

// ---- 主流程 ----

export async function runDailyLearning(): Promise<{ scanned: number; learned: number; newKeywords: number }> {
  const stats = { scanned: 0, learned: 0, newKeywords: 0 };
  const seen = new Set<string>();
  const learnedTitles: string[] = [];
  const allKeywords = new Set<string>();

  for (const kw of SEARCH_KEYWORDS) {
    let videos: BiliVideo[] = [];
    try {
      videos = await searchBilibili(kw.trim());
    } catch (err) {
      logger.error({ kw, err: (err as Error).message }, "DailyLearning: search failed");
      continue;
    }

    for (const video of videos) {
      if (seen.has(video.bvid)) continue;
      seen.add(video.bvid);
      stats.scanned++;

      const subtitle = await fetchSubtitleText(video.bvid);
      const knowledge = await distillWithDeepSeek(video, subtitle);
      if (!knowledge) continue;

      const saved = await saveToPlaybook(video, knowledge);
      if (saved) {
        stats.learned++;
        learnedTitles.push(video.title);
        for (const w of knowledge.keywords) allKeywords.add(`${w.ru}(${w.zh})`);
      }
    }
  }

  stats.newKeywords = allKeywords.size;

  // 飞书摘要
  if (stats.learned > 0) {
    await emitEvent("DAILY_LEARNING", {
      scanned: String(stats.scanned),
      learned: String(stats.learned),
      keywords: String(stats.newKeywords),
      titles: learnedTitles.slice(0, 3).join("；").slice(0, 200),
      topKeywords: Array.from(allKeywords).slice(0, 8).join("、").slice(0, 200),
    }).catch(() => {});
  }

  logger.info(stats, "DailyLearning: cycle complete");
  return stats;
}

// 手动触发入口（/api/task/run-learning）
export { runDailyLearning as default };
