// 知识库域 api + hooks — 各库统计、向量搜索、录入/导入
// 注意：/api/rag/* 均为裸对象返回（无 success/data 信封），在此直接标注类型
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

// ---- Types ----

/** GET /api/rag/stats — 裸对象，键为各知识库表名 */
export type RagStats = Record<string, number>;

export type RagSearchResult = {
  score?: number;
  content?: string;
  content_ru?: string;
  report_text?: string;
  original_text?: string;
  source?: string;
};

// ---- API Methods ----

export const ragApi = {
  stats: () => api.get("/api/rag/stats") as unknown as Promise<RagStats>,
  search: (kb: string, query: string, topK = 5, extra?: Record<string, unknown>) =>
    api.post(`/api/rag/${kb}/search`, { query, topK, ...extra }) as unknown as Promise<{ results: RagSearchResult[] }>,
  addAftersales: (data: Record<string, unknown>) => api.post("/api/rag/aftersales", data),
  addCompetitor: (data: Record<string, unknown>) => api.post("/api/rag/competitor", data),
  addProduct: (data: Record<string, unknown>) => api.post("/api/rag/product", data),
  addCopy: (data: Record<string, unknown>) => api.post("/api/rag/copy", data),
  addPlaybook: (data: Record<string, unknown>) => api.post("/api/rag/playbook", data),
  importAftersales: () => api.post("/api/rag/import/aftersales-history"),
  importCompetitor: () => api.post("/api/rag/import/competitor-history"),
};

const kbLabels: Record<string, string> = {
  aftersales: "售后话术",
  competitor: "竞品报告",
  product: "选品知识",
  copy: "文案模板",
  playbook: "运营经验",
};

/** /api/rag/stats 返回的键是表名（rag.route.ts stats 端点），映射到前端 kb 短名 */
const kbStatsKeys: Record<string, string> = {
  aftersales: "rag_aftersales_scripts",
  competitor: "rag_competitor_reports",
  product: "rag_product_knowledge",
  copy: "rag_copy_templates",
  playbook: "rag_operations_playbook",
};

export function useRagStats() {
  return useQuery({ queryKey: ["rag-stats"], queryFn: () => ragApi.stats(), refetchInterval: 30_000 });
}

export function useRagSearch(kb: string, query: string) {
  return useQuery({
    queryKey: ["rag-search", kb, query],
    queryFn: () => ragApi.search(kb, query, 5),
    enabled: !!query && !!kb,
  });
}

export function useRagAdd(kb: string) {
  const qc = useQueryClient();
  const addFn =
    kb === "aftersales" ? ragApi.addAftersales :
    kb === "competitor" ? ragApi.addCompetitor :
    kb === "product" ? ragApi.addProduct :
    kb === "copy" ? ragApi.addCopy : ragApi.addPlaybook;

  return useMutation({
    mutationFn: (data: Record<string, unknown>) => addFn(data),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rag-stats"] }); },
  });
}

export function useRagImport(kb: string) {
  const qc = useQueryClient();
  const importFn = kb === "aftersales" ? ragApi.importAftersales : ragApi.importCompetitor;
  return useMutation({
    mutationFn: () => importFn(),
    onSuccess: () => { qc.invalidateQueries({ queryKey: ["rag-stats"] }); },
  });
}

export { kbLabels, kbStatsKeys };
