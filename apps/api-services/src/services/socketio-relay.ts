// ============================================================
// Socket.io Relay — replaces ws-relay.ts with robust bidirectional
// Plugin bridge for 1688 download automation.
// Auto-reconnect, rooms per task, acknowledgements, heartbeat.
// Coexists with legacy ws at /ws/plugin-bridge (backward compat).
// ============================================================

import { Server as SocketIoServer } from "socket.io";
import { logger } from "@onzo/logger";
import { randomUUID } from "node:crypto";

export interface PluginSession {
  socketId: string;
  pluginId: string;
  connectedAt: string;
  lastPing: number;
  activeDownloads: Set<string>;
}

export interface DownloadTask {
  taskId: string;
  keyword: string;
  status: "pending" | "downloading" | "complete" | "failed";
  progress: number;
  totalFiles: number;
  failedFiles: number;
  startedAt: string;
  completedAt?: string;
}

const sessions = new Map<string, PluginSession>();
const tasks = new Map<string, DownloadTask>();

let io: SocketIoServer | null = null;

export function startSocketIoRelay(server: import("http").Server): SocketIoServer {
  io = new SocketIoServer(server, {
    path: "/ws",
    pingInterval: 25_000,
    pingTimeout: 20_000,
    connectTimeout: 10_000,
    maxHttpBufferSize: 1e6, // 1MB
    cors: { origin: "*", methods: ["GET", "POST"] },
  });

  io.on("connection", (socket) => {
    const pluginId = `plugin_${randomUUID().slice(0, 8)}`;
    const session: PluginSession = {
      socketId: socket.id,
      pluginId,
      connectedAt: new Date().toISOString(),
      lastPing: Date.now(),
      activeDownloads: new Set(),
    };
    sessions.set(socket.id, session);
    // Also index by pluginId for direct targeting
    sessions.set(pluginId, session);

    logger.info({ pluginId, socketId: socket.id }, "Socket.io plugin connected");
    socket.emit("welcome", { pluginId, socketId: socket.id });

    // ---- Download commands ----
    socket.on("chrome.cmd.download", (msg: { taskId: string; urls: string[]; keyword: string }, ack) => {
      if (!msg.taskId || !msg.urls?.length) {
        ack?.({ error: "Missing taskId or urls" });
        return;
      }
      session.activeDownloads.add(msg.taskId);
      tasks.set(msg.taskId, {
        taskId: msg.taskId,
        keyword: msg.keyword || "",
        status: "downloading",
        progress: 0,
        totalFiles: msg.urls.length,
        failedFiles: 0,
        startedAt: new Date().toISOString(),
      });
      logger.info({ pluginId, taskId: msg.taskId, urlCount: msg.urls.length }, "Download command dispatched");
      ack?.({ status: "accepted", taskId: msg.taskId });
    });

    // ---- Download progress ----
    socket.on("chrome.evt.progress", (msg: { taskId: string; progress: number; totalFiles: number; failedFiles: number }) => {
      const task = tasks.get(msg.taskId);
      if (task) {
        task.progress = msg.progress;
        task.totalFiles = msg.totalFiles;
        task.failedFiles = msg.failedFiles;
        task.status = "downloading";
      }
      // Broadcast to all listeners in task room
      io?.to(`task:${msg.taskId}`).emit("download.progress", msg);
    });

    // ---- Download complete ----
    socket.on("chrome.evt.complete", (msg: { taskId: string; totalFiles: number; failedFiles: number; files?: Array<{ path: string; size: number }> }) => {
      const task = tasks.get(msg.taskId);
      if (task) {
        task.status = msg.failedFiles > 0 ? "complete" : "complete";
        task.progress = 100;
        task.totalFiles = msg.totalFiles;
        task.failedFiles = msg.failedFiles;
        task.completedAt = new Date().toISOString();
        session.activeDownloads.delete(msg.taskId);
      }
      io?.to(`task:${msg.taskId}`).emit("download.complete", msg);
      logger.info({ taskId: msg.taskId, files: msg.totalFiles, failed: msg.failedFiles }, "Download complete");
    });

    // ---- Download error ----
    socket.on("chrome.evt.error", (msg: { taskId: string; error: string }) => {
      const task = tasks.get(msg.taskId);
      if (task) {
        task.status = "failed";
        session.activeDownloads.delete(msg.taskId);
      }
      io?.to(`task:${msg.taskId}`).emit("download.error", msg);
      logger.warn({ taskId: msg.taskId, error: msg.error }, "Download error");
    });

    // ---- Heartbeat ----
    socket.on("ping", () => {
      const s = sessions.get(socket.id);
      if (s) s.lastPing = Date.now();
    });

    // ---- Disconnect ----
    socket.on("disconnect", (reason) => {
      sessions.delete(socket.id);
      sessions.delete(pluginId);
      logger.info({ pluginId, reason }, "Socket.io plugin disconnected");
    });
  });

  logger.info("Socket.io relay started on /ws");
  return io;
}

// ---- Public API ----

/** Join a room to listen for a specific task's progress */
export function joinTaskRoom(socketId: string, taskId: string): void {
  const socket = io?.sockets.sockets.get(socketId);
  if (socket) socket.join(`task:${taskId}`);
}

/** Send download command to a specific plugin */
export function sendDownloadCommand(pluginId: string, task: { taskId: string; urls: string[]; keyword: string }): boolean {
  const session = sessions.get(pluginId);
  if (!session) return false;
  const socket = io?.sockets.sockets.get(session.socketId);
  if (!socket?.connected) return false;
  socket.emit("chrome.cmd.download", task);
  return true;
}

/** Get online plugin count */
export function getOnlinePluginCount(): number {
  let count = 0;
  for (const [, s] of sessions) {
    if (s.socketId && io?.sockets.sockets.get(s.socketId)?.connected) count++;
  }
  return Math.floor(count / 2); // Each plugin has 2 entries (by socketId + pluginId)
}

/** Get task progress */
export function getTaskProgress(taskId: string): DownloadTask | null {
  return tasks.get(taskId) || null;
}

/** Get all online plugin IDs */
export function getOnlinePlugins(): string[] {
  const plugins: string[] = [];
  for (const [key, s] of sessions) {
    if (key.startsWith("plugin_") && io?.sockets.sockets.get(s.socketId)?.connected) {
      plugins.push(key);
    }
  }
  return plugins;
}

/** Get the socket.io instance (for external use) */
export function getIo(): SocketIoServer | null {
  return io;
}
