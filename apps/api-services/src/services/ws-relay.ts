// ============================================================
// WebSocket Relay — plugin bridge for 1688 download automation
// /ws/plugin-bridge — persistent connections from Chrome plugins
// ============================================================

import { WebSocketServer, WebSocket } from "ws";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";

interface PluginSession {
  ws: WebSocket;
  pluginId: string;
  connectedAt: string;
  lastPing: number;
}

interface DownloadTask {
  taskId: string;
  keyword: string;
  status: "pending" | "downloading" | "complete" | "failed";
  progress: number;
  totalFiles: number;
  failedFiles: number;
  startedAt: string;
}

const sessions = new Map<string, PluginSession>();
const tasks = new Map<string, DownloadTask>();

let wss: WebSocketServer | null = null;

export function startWsRelay(server: import("http").Server) {
  wss = new WebSocketServer({ server, path: "/ws/plugin-bridge" });

  wss.on("connection", (ws) => {
    const pluginId = `plugin_${randomUUID().slice(0, 8)}`;
    const session: PluginSession = { ws, pluginId, connectedAt: new Date().toISOString(), lastPing: Date.now() };
    sessions.set(pluginId, session);

    logger.info({ pluginId }, "Plugin WebSocket connected");
    ws.send(JSON.stringify({ type: "welcome", pluginId }));

    // Ping/pong keepalive
    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.ping();
        session.lastPing = Date.now();
      }
    }, 30_000);

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        handleMessage(pluginId, msg);
      } catch (e) { logger.warn({ err: (e as Error).message }, "WS invalid message"); }
    });

    ws.on("close", () => {
      clearInterval(pingInterval);
      sessions.delete(pluginId);
      logger.info({ pluginId }, "Plugin WebSocket disconnected");
    });

    ws.on("error", (err) => {
      logger.warn({ pluginId, err: err.message }, "WS error");
      sessions.delete(pluginId);
    });
  });

  logger.info("WebSocket relay started on /ws/plugin-bridge");
}

function handleMessage(pluginId: string, msg: Record<string, unknown>) {
  switch (msg.type) {
    case "download_progress":
      tasks.set(msg.taskId as string, {
        taskId: msg.taskId as string,
        keyword: msg.keyword as string,
        status: msg.status as DownloadTask["status"],
        progress: msg.progress as number,
        totalFiles: msg.totalFiles as number,
        failedFiles: msg.failedFiles as number,
        startedAt: msg.startedAt as string,
      });
      break;
    case "download_complete":
      tasks.set(msg.taskId as string, {
        taskId: msg.taskId as string,
        keyword: msg.keyword as string,
        status: "complete",
        progress: 100,
        totalFiles: msg.totalFiles as number,
        failedFiles: msg.failedFiles as number,
        startedAt: msg.startedAt as string,
      });
      break;
    case "ping":
      const s = sessions.get(pluginId);
      if (s) s.lastPing = Date.now();
      break;
  }
}

// Send download command to a plugin
export function sendDownloadCommand(pluginId: string, task: { taskId: string; url: string; keyword: string }): boolean {
  const session = sessions.get(pluginId);
  if (!session || session.ws.readyState !== WebSocket.OPEN) return false;
  session.ws.send(JSON.stringify({ type: "download_cmd", ...task }));
  return true;
}

// Get online plugin count
export function getOnlinePluginCount(): number {
  let count = 0;
  for (const [, s] of sessions) {
    if (s.ws.readyState === WebSocket.OPEN) count++;
  }
  return count;
}

// Get task progress
export function getTaskProgress(taskId: string): DownloadTask | null {
  return tasks.get(taskId) || null;
}

// Get all online plugin IDs
export function getOnlinePlugins(): string[] {
  return [...sessions.keys()];
}
