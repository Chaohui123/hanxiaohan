import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "./client";

export const ragApi = {
  stats: () => api.get("/api/rag/stats"),
  search: (kb: string, query: string, topK = 5, extra?: Record<string, unknown>) =>
    api.post(`/api/rag/${kb}/search`, { query, topK, ...extra }),
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

export { kbLabels };
