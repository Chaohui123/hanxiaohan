// 售后域 api + hooks — 工单列表、解决/拒绝/AI 回复
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, unwrapData } from "./client";

// ---- Types ----

export interface CaseRow {
  id: string;
  posting_number: string;
  type: string;
  status: string;
  reason: string;
  refund_amount_rub?: number;
  created_at: string;
}

export interface AutoReplyResult {
  reply: string;
  confidence: number;
  source?: string;
}

// ---- API Methods ----

export const aftersalesApi = {
  list: () => unwrapData<CaseRow[]>(api.get("/api/aftersales/cases")),
  resolve: (id: string, resolutionNote: string) =>
    api.post(`/api/aftersales/cases/${id}/resolve`, { resolutionNote }),
  reject: (id: string, resolutionNote: string) =>
    api.post(`/api/aftersales/cases/${id}/reject`, { resolutionNote }),
  autoReply: (id: string) =>
    unwrapData<AutoReplyResult>(api.post(`/api/aftersales/cases/${id}/auto-reply`)),
};

// ---- React Query Hooks ----

export function useAftersalesCases() {
  return useQuery({ queryKey: ["aftersales"], queryFn: () => aftersalesApi.list() });
}

export function useResolveCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; resolutionNote: string }) => aftersalesApi.resolve(args.id, args.resolutionNote),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aftersales"] }),
  });
}

export function useRejectCase() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { id: string; resolutionNote: string }) => aftersalesApi.reject(args.id, args.resolutionNote),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aftersales"] }),
  });
}

export function useAutoReply() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => aftersalesApi.autoReply(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["aftersales"] }),
  });
}
