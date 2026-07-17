// ============================================================
// Freight Address — centralized via FREIGHT_ADDRESS env var
// Edit .env to change; all modules read from this single source
// ============================================================

export const FREIGHT_ADDRESS =
  process.env.FREIGHT_ADDRESS ||
  "广东省东莞市常平镇土塘港建路45号7号楼放兔喜240247室 韩小寒 18928225650";
