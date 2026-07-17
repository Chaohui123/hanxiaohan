// ============================================================
// Built-in Task Scheduler — replaces n8n for periodic jobs
// Register jobs at startup, runs them on configured intervals.
// Features: timeout enforcement, duration logging, failure circuit breaker,
//            optional Redis-based leader election for multi-instance deployments.
// ============================================================

import { logger } from "@onzo/logger";

interface ScheduledJob {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun?: number;
  running?: boolean;
  consecutiveFailures: number;
  /** Maximum job execution time in ms (0 = use default: min(intervalMs/2, maxJobTimeoutMs)) */
  timeoutMs?: number;
}

const jobs: ScheduledJob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let leaderCheckTimer: ReturnType<typeof setInterval> | null = null;
let isLeader = false;
let leaderToken: string | null = null;

/** Max consecutive failures before logging a CIRCUIT_BREAKER_OPEN alert */
const MAX_CONSECUTIVE_FAILURES = 3;

/** Leader election lock TTL (seconds) — refresh at half TTL */
const LEADER_TTL_SEC = 30;
const LEADER_REFRESH_MS = (LEADER_TTL_SEC / 2) * 1000;

export function registerJob(
  name: string,
  intervalMs: number,
  handler: () => Promise<void>,
  opts?: { timeoutMs?: number }
): void {
  jobs.push({ name, intervalMs, handler, consecutiveFailures: 0, timeoutMs: opts?.timeoutMs });
  logger.info({ job: name, intervalMs }, "Scheduled job registered");
}

export async function startScheduler(): Promise<void> {
  if (timer) return;

  // ---- Leader election (only when Redis URL is configured) ----
  const redisUrl = process.env.REDIS_URL;
  const schedulerLockEnabled = process.env.SCHEDULER_LEADER_LOCK !== "false" && !!redisUrl;

  if (schedulerLockEnabled) {
    // Try to acquire leader lock immediately
    leaderToken = await tryAcquireLeaderLock();
    isLeader = leaderToken !== null;

    // Refresh leader lock periodically
    leaderCheckTimer = setInterval(async () => {
      if (isLeader && leaderToken) {
        // Extend the existing lock (re-acquire with NX would fail since key exists)
        const { extendLock } = await import("./redis-lock.js");
        const extended = await extendLock("scheduler:leader", leaderToken, LEADER_TTL_SEC);
        if (!extended) {
          logger.warn("Scheduler: failed to extend leader lock — lock may have expired or been taken");
          isLeader = false;
          leaderToken = null;
        }
      } else {
        // Try to become leader
        leaderToken = await tryAcquireLeaderLock();
        isLeader = leaderToken !== null;
      }
    }, LEADER_REFRESH_MS);

    if (!isLeader) {
      logger.info({ jobs: jobs.map((j) => j.name) }, "Scheduler started as FOLLOWER — waiting for leader lock");
    }
  } else {
    // Standalone mode — always leader
    isLeader = true;
  }

  if (isLeader) {
    logger.info({ jobs: jobs.map((j) => j.name) }, "Scheduler started as LEADER");
  }

  // Stagger initial runs over 60 seconds (leader only)
  if (isLeader) {
    jobs.forEach((job, i) => {
      setTimeout(() => runJob(job), (i + 1) * 10_000);
    });
  }

  // Check every 60 seconds if any job is due (all instances check, but only leader runs)
  timer = setInterval(() => {
    if (!isLeader) return; // follower — skip job execution
    const now = Date.now();
    for (const job of jobs) {
      if (job.running) continue;
      if (!job.lastRun || now - job.lastRun >= job.intervalMs) {
        runJob(job);
      }
    }
  }, 60_000);
}

export async function stopScheduler(): Promise<void> {
  if (timer) { clearInterval(timer); timer = null; }
  if (leaderCheckTimer) { clearInterval(leaderCheckTimer); leaderCheckTimer = null; }
  // Release leader lock on clean shutdown to allow fast failover
  if (isLeader && leaderToken) {
    try {
      const { unlock } = await import("./redis-lock.js");
      await unlock("scheduler:leader", leaderToken);
    } catch { /* best effort */ }
    leaderToken = null;
    isLeader = false;
  }
  logger.info("Scheduler stopped");
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  lastRun: string | null;
  consecutiveFailures: number;
  running: boolean;
  isLeader: boolean;
}

export function getJobsStatus(): JobStatus[] {
  return jobs.map((j) => ({
    name: j.name,
    intervalMs: j.intervalMs,
    lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
    consecutiveFailures: j.consecutiveFailures,
    running: !!j.running,
    isLeader,
  }));
}

// ---- Internal ----

async function tryAcquireLeaderLock(): Promise<string | null> {
  try {
    // Dynamic import to avoid circular deps at module load
    const { acquireLock } = await import("./redis-lock.js");
    const token = await acquireLock("scheduler:leader", LEADER_TTL_SEC);
    return token;
  } catch {
    // Redis unavailable — be conservative: don't assume leadership.
    // Single-instance deployments already bypass leader election entirely
    // (schedulerLockEnabled=false → isLeader=true without calling this function).
    // Returning null here prevents split-brain when Redis is configured but unreachable.
    return null;
  }
}

function getDefaultTimeout(intervalMs: number): number {
  // Default: half the interval, capped at the env-configurable max (default 5 min)
  const maxJobTimeoutMs = parseInt(process.env.SCHEDULER_MAX_JOB_TIMEOUT_MS || "300000", 10);
  return Math.min(intervalMs / 2, maxJobTimeoutMs);
}

function timeout(ms: number): Promise<never> {
  return new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`Job timed out after ${ms}ms`)), ms)
  );
}

async function runJob(job: ScheduledJob): Promise<void> {
  job.running = true;
  job.lastRun = Date.now();
  const startTime = Date.now();

  const timeoutMs = job.timeoutMs ?? getDefaultTimeout(job.intervalMs);

  try {
    logger.info({ job: job.name }, "Running scheduled job");
    await Promise.race([job.handler(), timeout(timeoutMs)]);
    const durationMs = Date.now() - startTime;
    job.consecutiveFailures = 0;
    logger.info({ job: job.name, durationMs }, "Scheduled job completed");
  } catch (err) {
    const durationMs = Date.now() - startTime;
    job.consecutiveFailures++;
    logger.error({
      job: job.name,
      err: (err as Error).message,
      durationMs,
      consecutiveFailures: job.consecutiveFailures,
    }, "Scheduled job failed");

    if (job.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
      logger.fatal({
        job: job.name,
        consecutiveFailures: job.consecutiveFailures,
      }, "CIRCUIT_BREAKER_OPEN — job has failed 3 consecutive times, investigate immediately");
    }
  } finally {
    job.running = false;
  }
}
