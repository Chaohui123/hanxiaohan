// 上架域 api — 手动上架、批量导入、模板下载、自动选品
import { api, unwrapData } from "./client";

// ---- Types ----

export type AutoSelectProduct = {
  url: string;
  title?: string;
  price?: number;
  margin?: number;
  finalScore?: number;
};

export type AutoSelectResult = {
  keyword?: string;
  candidates?: number;
  topProduct?: AutoSelectProduct | null;
  topScore?: number;
  topScoreProducts?: AutoSelectProduct[];
  secondarySort?: AutoSelectProduct[];
  validateFailType?: string;
  validationPassed?: boolean;
  validationIssues?: string[];
  listingTaskId?: string | null;
  promoPlanId?: string | null;
  report?: string;
};

// ---- API Methods ----

export const listingApi = {
  submit: (url: string) => api.post("/api/process", { url }),
  /** 批量导入 xlsx（base64），返回 { enqueued } */
  importXlsx: (fileBase64: string) =>
    unwrapData<{ enqueued?: number }>(api.post("/api/bulk/import/xlsx", { fileBase64 })),
  /** 批量导入 csv（base64），返回 { enqueued } */
  importCsv: (fileBase64: string) =>
    unwrapData<{ enqueued?: number }>(api.post("/api/bulk/import/csv", { fileBase64 })),
  /** window.open 不带 X-API-Key 会 401 — 用 axios blob 下载后由页面触发浏览器保存 */
  downloadTemplate: () => api.get("/api/bulk/template", { responseType: "blob" }) as unknown as Promise<Blob>,
  autoSelect: (keyword: string) => unwrapData<AutoSelectResult>(api.post("/api/auto-select", { keyword })),
  manualPublish: (url: string) => api.post("/api/market/manual-publish", { url }),
};
