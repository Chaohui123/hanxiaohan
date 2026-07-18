// ============================================================
// Material Routes — plugin download progress + upload
// ============================================================

import { Router } from "express";
import { getTaskProgress, sendDownloadCommand, getOnlinePluginCount, getOnlinePlugins } from "../services/ws-relay.js";
import { logger } from "@onzo/logger";

export function createMaterialRouter(): Router {
  const router = Router();

  // GET /api/plugin/status — online status
  router.get("/plugin/status", (_req, res) => {
    const onlineCount = getOnlinePluginCount();
    const plugins = getOnlinePlugins();
    res.json({
      success: true,
      data: { online: onlineCount > 0, count: onlineCount, plugins },
      correlationId: _req.correlationId,
    });
  });

  // POST /api/plugin/re-download — manual retrigger download
  router.post("/plugin/re-download", (req, res) => {
    const { url, keyword } = (req.body || {}) as { url?: string; keyword?: string };
    if (!url) return res.status(400).json({ success: false, error: { code: "MISSING", message: "url required" } });

    const plugins = getOnlinePlugins();
    if (plugins.length === 0) {
      return res.status(503).json({ success: false, error: { code: "PLUGIN_OFFLINE", message: "无在线插件" } });
    }

    const taskId = `dl_${Date.now()}`;
    const sent = sendDownloadCommand(plugins[0]!, { taskId, url, keyword: keyword || "" });

    res.json({
      success: sent,
      data: { taskId, pluginId: plugins[0] },
      message: sent ? "下载指令已下发" : "发送失败",
      correlationId: req.correlationId,
    });
  });

  // GET /api/material/task-progress/:taskId
  router.get("/material/task-progress/:taskId", (req, res) => {
    const task = getTaskProgress(req.params.taskId);
    if (!task) return res.status(404).json({ success: false, error: { code: "NOT_FOUND" } });
    res.json({ success: true, data: task, correlationId: req.correlationId });
  });

  return router;
}
