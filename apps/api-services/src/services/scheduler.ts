// ============================================================
// Built-in Task Scheduler — replaces n8n for periodic jobs
// Register jobs at startup, runs them on configured intervals
// ============================================================

import { logger } from "@onzo/logger";

interface ScheduledJob {
  name: string;
  intervalMs: number;
  handler: () => Promise<void>;
  lastRun?: number;
  running?: boolean;
}

const jobs: ScheduledJob[] = [];
let timer: ReturnType<typeof setInterval> | null = null;

export function registerJob(name: string, intervalMs: number, handler: () => Promise<void>): void {
  jobs.push({ name, intervalMs, handler });
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

async function runJob(job: ScheduledJob): Promise<void> {
  job.running = true;
  job.lastRun = Date.now();
  try {
    logger.info({ job: job.name }, "Running scheduled job");
    await job.handler();
    logger.info({ job: job.name }, "Scheduled job completed");
  } catch (err) {
    logger.error({ job: job.name, err: (err as Error).message }, "Scheduled job failed");
  } finally {
    job.running = false;
  }
}
