import { createHash } from "node:crypto";
import { mkdir, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

export async function sha256File(file) {
  return sha256Text(await readFile(file, "utf8"));
}

export async function readJson(file) {
  const text = await readFile(file, "utf8");
  try { return JSON.parse(text); }
  catch { throw new Error(`Invalid JSON input: ${file}`); }
}

export function validateSourceSnapshot(source, now = new Date()) {
  if (!source || typeof source !== "object" || Array.isArray(source)) throw new Error("Weekly source must be an object");
  const collectedAt = Date.parse(source.collectedAt || "");
  if (!Number.isFinite(collectedAt)) throw new Error("Weekly source has no valid collectedAt");
  if (!source.operationsPeriod?.dateFrom || !source.operationsPeriod?.dateTo || !source.operationsTotals) {
    throw new Error("Weekly source lacks the operations window or totals");
  }
  const ageHours = (now.getTime() - collectedAt) / 3_600_000;
  if (ageHours < -0.25) throw new Error("Weekly source timestamp is in the future");
  return {
    collectedAt: source.collectedAt,
    period: source.operationsPeriod,
    ageHours: Math.round(ageHours * 100) / 100,
    stale: ageHours > 36,
    usableAsCurrent: ageHours <= 36,
    note: "陈旧数据只能标为历史参考，不能冒充本周最新经营快照",
  };
}

export function validateCompetitorRun(latest, lastRun, now = new Date()) {
  const errors = [];
  if (!latest || typeof latest !== "object") errors.push("missing_latest");
  if (!lastRun || typeof lastRun !== "object") errors.push("missing_last_run");
  if (errors.length) return { usable: false, errors };
  const latestId = latest.runId || latest.run_id;
  const lastRunId = lastRun.runId || lastRun.run_id;
  if (!latestId || !lastRunId || latestId !== lastRunId) errors.push("run_id_mismatch");
  if (lastRun.fatalError || lastRun.fatal) errors.push("fatal_last_run");
  if (lastRun.dryRun === true || lastRun.isSubset === true || lastRun.subset === true) errors.push("partial_or_dry_run");
  const filters = [latest.filters, lastRun.filters];
  if (filters.some(value => value?.offerId || value?.limit || value?.onlyFailed)) errors.push("partial_or_dry_run");
  if (lastRun.usable === false || lastRun.lastRunUsable === false) errors.push("last_run_unusable");
  const pending = typeof lastRun.pendingReconciliation === "object" ? lastRun.pendingReconciliation?.count : lastRun.pendingReconciliation;
  if (Number(pending || 0) !== 0) errors.push("pending_reconciliation");
  if (!Array.isArray(lastRun.reconciliationErrors) || lastRun.reconciliationErrors.length) errors.push("reconciliation_errors");
  const collectedAt = lastRun.completedAt || latest.completedAt || latest.startedAt;
  const completedAt = Date.parse(collectedAt || "");
  const completedAgeHours = Number.isFinite(completedAt) ? Math.round((now.getTime() - completedAt) / 36_000) / 100 : null;
  if (completedAgeHours === null) errors.push("missing_completion_time");
  else if (completedAgeHours < -0.25) errors.push("future_completion_time");
  else if (completedAgeHours > 36) errors.push("stale_completion_time");
  const directRows = Array.isArray(latest.links) ? latest.links.filter(row => row?.includeInPriceComparison === true) : [];
  const capturedTimes = directRows.map(row => Date.parse(row.snapshot?.capturedAt || row.capturedAt || ""));
  const validTimes = capturedTimes.filter(Number.isFinite);
  if (!directRows.length || validTimes.length !== directRows.length) errors.push("missing_direct_snapshot_timestamps");
  const oldest = validTimes.length ? Math.min(...validTimes) : null;
  const oldestDirectAgeHours = oldest === null ? null : Math.round((now.getTime() - oldest) / 36_000) / 100;
  if (oldestDirectAgeHours === null || oldestDirectAgeHours > 24) errors.push("stale_direct_snapshot");
  if (validTimes.some(value => value > now.getTime())) errors.push("future_direct_snapshot");
  const totals = lastRun.totals || latest.totals || {};
  const failureCounts = Object.fromEntries([
    ["comparisonFetchFailed", "fetchFailed"], ["comparisonIdentityMismatch", "identityMismatch"],
    ["comparisonMissingRequired", null], ["uploadFailures", null],
  ].map(([key, legacy]) => [key, Number(totals[key] ?? (legacy ? totals[legacy] : 0) ?? 0)]));
  if (Object.values(failureCounts).some(value => !Number.isFinite(value) || value > 0)) errors.push("collection_failures");
  const stale = errors.some(error => error.startsWith("stale_") || error.startsWith("future_") || error === "missing_direct_snapshot_timestamps");
  return {
    usable: errors.length === 0, errors, runId: latestId || null,
    lastRunUsable: !errors.some(error => ["missing_last_run", "run_id_mismatch", "fatal_last_run", "partial_or_dry_run", "last_run_unusable"].includes(error)),
    stale, source: lastRun.source || latest.source || null, collectedAt: collectedAt || null,
    completedAgeHours, oldestDirectAgeHours, directSnapshotCount: directRows.length,
    failureCounts, pendingReconciliationCount: Number(pending || 0),
  };
}

export function parseIntegrationResponse(raw) {
  const value = typeof raw === "string" ? raw.trim() : raw;
  const parsed = typeof value === "object" && value !== null ? value : (() => {
    const text = String(value);
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    return JSON.parse(fenced ? fenced[1] : text);
  })();
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Kimi integration is not a JSON object");
  const actions = parsed.actions ?? parsed.nextWeekActions;
  if (!Array.isArray(actions)) throw new Error("Kimi integration has no actions array");
  if (actions.length > 3) throw new Error("Kimi integration returned more than three actions");
  for (const action of actions) {
    if (!action || typeof action !== "object" || Array.isArray(action)) throw new Error("Invalid action in Kimi integration");
  }
  return { ...parsed, actions };
}

export function modelFailure(error, fallbackCode = "MODEL_CALL_FAILED") {
  return {
    status: "FAILED",
    errorCode: error?.code || fallbackCode,
    error: String(error?.message || error).slice(0, 500),
  };
}

export class WeeklyReviewStore {
  constructor(root = "data/weekly-reviews") {
    this.root = path.resolve(root);
    this.lockPath = path.join(this.root, "runner.lock");
    this.handle = null;
  }

  async begin(runId) {
    if (!/^[\w.-]+$/.test(runId)) throw new Error("Invalid weekly runId");
    await mkdir(this.root, { recursive: true });
    try {
      this.handle = await open(this.lockPath, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      let owner;
      try { owner = await readJson(this.lockPath); } catch { throw new Error("Weekly runner lock is unreadable; do not remove it blindly"); }
      let alive = true;
      if (Number.isInteger(owner.pid)) {
        try { process.kill(owner.pid, 0); } catch (error) { alive = error.code !== "ESRCH"; }
      }
      if (alive) throw new Error("Another weekly review runner is active");
      await rm(this.lockPath, { force: true });
      this.handle = await open(this.lockPath, "wx", 0o600);
    }
    this.runId = runId;
    this.directory = path.join(this.root, "runs", runId);
    await mkdir(this.directory, { recursive: true });
    await this.handle.writeFile(JSON.stringify({ runId, pid: process.pid, startedAt: new Date().toISOString() }));
    return this.directory;
  }

  async resume(directory) {
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.join(this.root, "runs")) throw new Error("Resume directory must be an existing run inside this weekly review store");
    try {
      await readFile(path.join(resolved, "source.json"), "utf8");
    } catch (error) {
      throw Object.assign(new Error(`Cannot resume weekly review: ${error.message}`), { code: "RESUME_EVIDENCE_INCOMPLETE" });
    }
    return this.begin(path.basename(resolved));
  }

  async writeArtifact(name, contents) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid artifact name");
    const file = path.join(this.directory, name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, contents, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return file;
  }

  async writeJsonArtifact(name, value) {
    const text = `${JSON.stringify(value, null, 2)}\n`;
    await this.writeArtifact(name, text);
    return { path: path.join(this.directory, name), sha256: sha256Text(text) };
  }

  async writeRootJson(name, value) {
    if (!/^[\w.-]+$/.test(name)) throw new Error("Invalid root state filename");
    const text = `${JSON.stringify(value, null, 2)}\n`;
    const file = path.join(this.root, name);
    const temporary = `${file}.${process.pid}.tmp`;
    await writeFile(temporary, text, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, file);
    return { path: file, sha256: sha256Text(text) };
  }

  async complete(report) {
    if (!report || !["COMPLETED", "COMPLETED_WITH_DECLARED_GAPS"].includes(report.status)) throw new Error("Only a validated completed report can be published");
    const evidence = await this.writeJsonArtifact("report.json", report);
    const lastRun = {
      runId: this.runId,
      status: report.status === "COMPLETED" ? "succeeded" : "succeeded_with_gaps",
      reportStatus: report.status,
      finishedAt: report.finishedAt,
      latestReviewSha256: evidence.sha256,
      modelStatuses: report.models,
      productionChanges: false,
    };
    await this.writeRootJson("last-run.json", lastRun);
    await this.writeRootJson("latest-review.json", report);
    await this.writeRootJson("last-success.json", { runId: this.runId, finishedAt: report.finishedAt, status: lastRun.status, contentSha256: evidence.sha256 });
    return { reportPath: evidence.path, contentSha256: evidence.sha256 };
  }

  async fail(error) {
    const failure = {
      runId: this.runId,
      status: "failed",
      finishedAt: new Date().toISOString(),
      errorCode: error?.code || "WEEKLY_REVIEW_FAILED",
      error: String(error?.message || error).slice(0, 500),
      productionChanges: false,
    };
    await this.writeRootJson("last-run.json", failure);
    return failure;
  }

  async end() {
    if (this.handle) await this.handle.close();
    this.handle = null;
    await rm(this.lockPath, { force: true });
  }
}
