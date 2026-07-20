// ============================================================
// Shared time helpers — single timestamp format across the codebase.
// DB timestamps (SQLite datetime('now') / PG NOW()) render as
// "YYYY-MM-DD HH:MM:SS" (UTC). TS write points must produce the
// exact same format so ORDER BY / string comparison stay correct
// and columns never mix ISO-8601 with datetime strings.
// ============================================================

/**
 * UTC time in the canonical DB format ("YYYY-MM-DD HH:MM:SS"),
 * identical to SQLite datetime('now') / PG NOW() rendering.
 * Use this instead of new Date().toISOString() for DB writes/comparisons.
 * @param offsetMs offset from now in milliseconds (e.g. -15*60_000 for 15 min ago)
 */
export function nowDb(offsetMs = 0): string {
  return new Date(Date.now() + offsetMs).toISOString().slice(0, 19).replace("T", " ");
}
