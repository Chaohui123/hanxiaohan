// ============================================================
// 未读角标工具 — localStorage 记录各频道已读位置
// 角标 = 已读位置之后的新内容数；点击查看后清零，有新内容再出现
// ============================================================

const SEEN_PREFIX = "onzo-seen:";

/** 频道上次已读时间（ms epoch）；无记录返回 0（全部算未读） */
export function getSeenAt(channel: string): number {
  try {
    return Number(localStorage.getItem(SEEN_PREFIX + channel)) || 0;
  } catch {
    return 0;
  }
}

/** 标记频道已读（默认标记到当前时间） */
export function markSeen(channel: string, ts = Date.now()): void {
  try {
    localStorage.setItem(SEEN_PREFIX + channel, String(ts));
  } catch { /* storage full/blocked — ignore */ }
}

/** 频道是否有任何已读记录（用于首次进入时初始化，避免历史内容全标未读） */
export function hasSeenRecord(channel: string): boolean {
  try {
    return localStorage.getItem(SEEN_PREFIX + channel) !== null;
  } catch {
    return false;
  }
}

// ---- 告警指纹已读集合（告警无时间戳，用内容指纹判新） ----

const READ_FP_KEY = "onzo-alerts-read";
const MAX_READ_FP = 100;

export function getReadFingerprints(): Set<string> {
  try {
    const arr = JSON.parse(localStorage.getItem(READ_FP_KEY) || "[]");
    return new Set(Array.isArray(arr) ? arr : []);
  } catch {
    return new Set();
  }
}

/** 把一组指纹并入已读集合（保持上限，先进先出） */
export function addReadFingerprints(fps: string[]): void {
  try {
    const merged = [...getReadFingerprints(), ...fps];
    const dedup = Array.from(new Set(merged)).slice(-MAX_READ_FP);
    localStorage.setItem(READ_FP_KEY, JSON.stringify(dedup));
  } catch { /* ignore */ }
}
