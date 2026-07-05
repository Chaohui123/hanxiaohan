// ============================================================
// Built-in Task Scheduler — replaces n8n for periodic jobs
// Register jobs at startup, runs them on configured intervals.
// Features: timeout enforcement, duration logging, failure circuit breaker
// ============================================================

import { logger } from "@onzo/logger";

interface ScheduledJob {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun?: number;
  running?: boolean;
  consecutiveFailures: number;
}

const jobs: ScheduledJob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

/** Max consecutive failures before logging a CIRCUIT_BREAKER_OPEN alert */
const MAX_CONSECUTIVE_FAILURES = 3;

export function registerJob(name: string, intervalMs: number, handler: () => Promise<void>): void {
  jobs.push({ name, intervalMs, handler, consecutiveFailures: 0 });
  logger.info({ job: name, intervalMs }, "Scheduled job registered");
}

export function startScheduler(): void {
  if (timer) return;
  logger.info({ jobs: jobs.map((j) => j.name) }, "Scheduler started");

  // Stagger initial runs over 60 seconds
  jobs.forEach((job, i) => {
    setTimeout(() => runJob(job), (i + 1) * 10_000);
  });

  // Check every 60 seconds if any job is due
  timer = setInterval(() => {
    const now = Date.now();
    for (const job of jobs) {
      if (job.running) continue;
      if (!job.lastRun || now - job.lastRun >= job.intervalMs) {
        runJob(job);
      }
    }
  }, 60_000);
}

export function stopScheduler(): void {
  if (timer) { clearInterval(timer); timer = null; }
  logger.info("Scheduler stopped");
}

export interface JobStatus {
  name: string;
  intervalMs: number;
  lastRun: string | null;
  consecutiveFailures: number;
  running: boolean;
}

export function getJobsStatus(): JobStatus[] {
  return jobs.map((j) => ({
    name: j.name,
    intervalMs: j.intervalMs,
    lastRun: j.lastRun ? new Date(j.lastRun).toISOString() : null,
    consecutiveFailures: j.consecutiveFailures,
    running: !!j.running,
  }));
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

  // Timeout at half the interval to prevent job overlap
  const timeoutMs = Math.min(job.intervalMs / 2, 300_000); // cap at 5 minutes

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
