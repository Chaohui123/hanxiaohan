import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  WeeklyReviewStore, parseIntegrationResponse, sha256Text,
  validateCompetitorRun, validateSourceSnapshot,
} from "../../../scripts/weekly-review-core.mjs";
import { astraAdapter, carbonAdapter, persistKimiIntegration, runWeeklyReview } from "../../../scripts/weekly-review-runner.mjs";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(path.join("temp", "weekly-review-test-")); });
afterEach(async () => { await rm(directory, { recursive: true, force: true }); });

function sourceFixture() {
  return {
    collectedAt: new Date().toISOString(),
    operationsPeriod: { days: 7, dateFrom: "2026-11-03", dateTo: "2026-11-09" },
    operationsTotals: { orderedUnits: 0, orderedRevenueRub: 0 },
  };
}

function validCompetitor() {
  const capturedAt = new Date(Date.now() - 60_000).toISOString();
  return {
    runId: "run-1", startedAt: capturedAt, completedAt: capturedAt, source: "fixture-server",
    fatalError: null, dryRun: false, filters: { offerId: null, limit: null, onlyFailed: false },
    totals: { fetchFailed: 0, comparisonFetchFailed: 0, comparisonIdentityMismatch: 0, comparisonMissingRequired: 0, uploadFailures: 0 },
    links: [{ includeInPriceComparison: true, capturedAt, snapshot: { capturedAt, priceType: "regular" } }],
    pendingReconciliation: 0, reconciliationErrors: [],
  };
}

describe("weekly review input and integration contracts", () => {
  it("distinguishes current, stale and future source snapshots", () => {
    const now = new Date();
    expect(validateSourceSnapshot(sourceFixture(), now).usableAsCurrent).toBe(true);
    const old = sourceFixture();
    old.collectedAt = new Date(now.getTime() - 48 * 3_600_000).toISOString();
    expect(validateSourceSnapshot(old, now)).toMatchObject({ stale: true, usableAsCurrent: false });
    const future = sourceFixture();
    future.collectedAt = new Date(now.getTime() + 3_600_000).toISOString();
    expect(() => validateSourceSnapshot(future, now)).toThrow("future");
  });

  it("requires matching latest and last-run evidence", () => {
    expect(validateCompetitorRun(validCompetitor(), validCompetitor()).usable).toBe(true);
    expect(validateCompetitorRun(validCompetitor(), { ...validCompetitor(), runId: "other" }).errors).toContain("run_id_mismatch");
    expect(validateCompetitorRun(validCompetitor(), { ...validCompetitor(), pendingReconciliation: 1 }).usable).toBe(false);
    expect(validateCompetitorRun(validCompetitor(), null).usable).toBe(false);
    const old = validCompetitor();
    old.completedAt = new Date(Date.now() - 48 * 3_600_000).toISOString();
    expect(validateCompetitorRun(validCompetitor(), old).errors).toContain("stale_completion_time");
    expect(validateCompetitorRun(validCompetitor(), { ...validCompetitor(), filters: { onlyFailed: true } }).errors).toContain("partial_or_dry_run");
    expect(validateCompetitorRun({ ...validCompetitor(), links: [{ includeInPriceComparison: true }] }, validCompetitor()).errors).toContain("missing_direct_snapshot_timestamps");
    const failed = validCompetitor();
    failed.totals.comparisonFetchFailed = 1;
    expect(validateCompetitorRun(failed, failed).errors).toContain("collection_failures");
  });

  it("accepts only structured integration with no more than three actions", () => {
    expect(parseIntegrationResponse(JSON.stringify({ summary: "test", nextWeekActions: [] })).actions).toEqual([]);
    expect(() => parseIntegrationResponse("no json")).toThrow();
    expect(() => parseIntegrationResponse({ actions: [{}, {}, {}, {}] })).toThrow("more than three");
  });
});

describe("persistent weekly review store", () => {
  it("serializes runs and preserves the last successful review after a later failure", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    await store.begin("run-1");
    await expect(new WeeklyReviewStore(path.join(directory, "weekly")).begin("run-2")).rejects.toThrow("active");
    const report = {
      runId: "run-1", status: "COMPLETED", finishedAt: new Date().toISOString(),
      models: [], nextWeekActions: [], productionChanges: false,
    };
    await store.complete(report);
    await store.end();
    const published = await readFile(path.join(store.root, "latest-review.json"), "utf8");
    const success = await readFile(path.join(store.root, "last-success.json"), "utf8");
    await store.begin("run-2");
    await store.fail(new Error("new model failed"));
    await store.end();
    expect(await readFile(path.join(store.root, "latest-review.json"), "utf8")).toBe(published);
    expect(await readFile(path.join(store.root, "last-success.json"), "utf8")).toBe(success);
    expect(await readFile(path.join(store.root, "last-run.json"), "utf8")).toContain('"status": "failed"');
    expect(JSON.parse(success).contentSha256).toBe(sha256Text(JSON.stringify(report, null, 2) + "\n"));
  });
});

describe("runner orchestration without external model calls", () => {
  it("freezes inputs, records real adapter outputs and publishes a validated report", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    const now = new Date();
    const result = await runWeeklyReview({
      store, now,
      fetchInputs: async (runDirectory: string) => {
        const source = path.join(runDirectory, "source.json");
        const competitor = path.join(runDirectory, "competitor.json");
        const lastRun = path.join(runDirectory, "competitor-last-run.json");
        await writeFile(source, JSON.stringify(sourceFixture()));
        await writeFile(competitor, JSON.stringify(validCompetitor()));
        await writeFile(lastRun, JSON.stringify(validCompetitor()));
        return { source, competitor, lastRun, direct: null };
      },
      adapters: {
        astra: async () => ({ seat: "Astra", status: "SUCCESS", actualModel: "fixture-astra", review: "A" }),
        carbon: async () => ({ seat: "Carbon", status: "SUCCESS", requestedModel: "gemini-4-carbon", actualModel: "fixture-carbon", review: "C" }),
        argon: async () => ({ seat: "Gemini", status: "SUCCESS", actualModel: "fixture-argon", review: "G" }),
      },
      integrator: async () => ({
        seat: "Kimi", status: "SUCCESS", actualModel: "fixture-kimi",
        review: { summary: "真实结构测试", actions: [{ priority: 1, action: "核验", owner: "Kimi", deadline: "2026-11-16", completionCriteria: ["回读"] }], dataGaps: [], stopped: [] },
      }),
      notifier: async () => {},
    });
    expect(result.report).toMatchObject({ status: "COMPLETED", productionChanges: false, nextWeekActions: [{ action: "核验" }] });
    expect(result.report.models).toHaveLength(4);
    expect(result.report.models.map((model: { seat: string }) => model.seat)).toEqual(["Astra", "Carbon", "Gemini", "Kimi"]);
    expect(await readFile(path.join(store.root, "latest-review.json"), "utf8")).toContain("真实结构测试");
    expect(result.report.evidence.promptSha256).toHaveLength(64);
    const routePath = path.join(store.directory, "model-route.json");
    expect(JSON.parse(await readFile(routePath, "utf8"))).toEqual({
      schemaVersion: 1, position: 2, seat: "Carbon", requestedModel: "gemini-4-carbon",
    });
    await expect(readFile(`${routePath}.${process.pid}.tmp`, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not publish a new report when final integration fails", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    await expect(runWeeklyReview({
      store,
      fetchInputs: async (runDirectory: string) => {
        const source = path.join(runDirectory, "source.json");
        const competitor = path.join(runDirectory, "competitor.json");
        const lastRun = path.join(runDirectory, "competitor-last-run.json");
        await writeFile(source, JSON.stringify(sourceFixture()));
        await writeFile(competitor, JSON.stringify(validCompetitor()));
        await writeFile(lastRun, JSON.stringify(validCompetitor()));
        return { source, competitor, lastRun, direct: null };
      },
      adapters: {
        astra: async () => ({ status: "SUCCESS" }), carbon: async () => ({ status: "SUCCESS" }), argon: async () => ({ status: "SUCCESS" }),
      },
      integrator: async () => { throw new Error("final integration unavailable"); },
      notifier: async () => {},
    })).rejects.toThrow("final integration unavailable");
    expect(JSON.parse(await readFile(path.join(store.root, "last-run.json"), "utf8"))).toMatchObject({ status: "failed", productionChanges: false });
    await expect(readFile(path.join(store.root, "latest-review.json"), "utf8")).rejects.toThrow();
  });

  it("uses absolute Git Bash and persists Astra stdout, stderr and CLI metadata", async () => {
    let command = "";
    const result = await astraAdapter("诊断提示词", directory, async (executable: string, args: string[], options: Record<string, unknown>) => {
      command = executable;
      expect(args).toEqual(["temp/gpt-assist.sh", "astra", "-"]);
      expect(options).toMatchObject({ input: "诊断提示词", allowNonzero: true });
      return {
        code: 0, stdout: "中文评审正文\n",
        stderr: "OpenAI Codex\r\nmodel: gpt-6-astra\r\nreasoning effort: high\r\nsession id: fixture-session\r\n",
      };
    });
    expect(path.isAbsolute(command)).toBe(true);
    expect(path.basename(command).toLowerCase()).toBe("bash.exe");
    expect(result).toMatchObject({ actualModel: "gpt-6-astra", actualEffort: "high", sessionId: "fixture-session", productionChanges: false });
    expect(await readFile(path.join(directory, "astra.txt"), "utf8")).toBe("中文评审正文\n");
    expect(JSON.parse(await readFile(path.join(directory, "astra-process.json"), "utf8"))).toMatchObject({ exitCode: 0, stdout: "中文评审正文\n", promptSha256: sha256Text("诊断提示词") });
  });

  it("persists process errors without creating a false Astra review", async () => {
    const error = Object.assign(new Error("spawnSync bash ENOENT"), { code: "ENOENT" });
    await expect(astraAdapter("诊断提示词", directory, async () => { throw error; })).rejects.toMatchObject({ code: "ENOENT" });
    expect(JSON.parse(await readFile(path.join(directory, "astra-process.json"), "utf8"))).toMatchObject({
      exitCode: null, stdout: "", stderr: "", error: { code: "ENOENT", message: "spawnSync bash ENOENT" },
    });
    await expect(readFile(path.join(directory, "astra.txt"), "utf8")).rejects.toThrow();
  });

  it("runs the Carbon text reviewer and preserves its model, effort and usage evidence", async () => {
    const promptPath = path.join(directory, "prompt.txt");
    await writeFile(promptPath, "Carbon周复盘提示词");
    const result = await carbonAdapter(promptPath, directory, async (command: string, args: string[], options: Record<string, unknown>) => {
      expect(command).toBe("python");
      expect(args).toEqual(["scripts/gemini-carbon-review.py", "--prompt-file", promptPath, "--output", path.join(directory, "carbon.json")]);
      expect(options).toEqual({ timeoutMs: 600_000, allowNonzero: true });
      await writeFile(path.join(directory, "carbon.json"), JSON.stringify(carbonEvidenceFixture()));
      return { code: 0, stdout: "{}", stderr: "" };
    });
    expect(result).toMatchObject({
      seat: "Carbon", requestedModel: "gemini-4-carbon", actualModel: "gemini-4-carbon",
      requestedEffort: "HIGH", actualEffort: null, status: "SUCCESS", review: "Carbon周复盘正文",
      usage: { totalTokenCount: 30 }, output: path.join(directory, "carbon.json"), productionChanges: false,
    });
  });

  it("rejects a nonzero Carbon process even when its failure receipt exists", async () => {
    const promptPath = path.join(directory, "prompt.txt");
    await expect(carbonAdapter(promptPath, directory, async () => {
      await writeFile(path.join(directory, "carbon.json"), JSON.stringify({
        ...carbonEvidenceFixture(), status: "FAILED", actualModel: null, review: "", rawContent: "",
        finishReason: "MAX_TOKENS", error: "Carbon finishReason must be STOP",
      }));
      return { code: 1, stdout: "{}", stderr: "" };
    })).rejects.toMatchObject({ code: "CARBON_EXECUTION_FAILED" });
  });

  it("persists the actual model, usage and raw content before rejecting invalid integration JSON", async () => {
    const rawContent = '{"summary":"unterminated';
    await expect(persistKimiIntegration(directory, {
      content: rawContent, parsed: null, model: "fixture-kimi",
      tokensUsed: { prompt: 100, completion: 20, total: 120 },
    })).rejects.toMatchObject({ code: "INVALID_INTEGRATION_JSON" });
    expect(JSON.parse(await readFile(path.join(directory, "kimi-final.json"), "utf8"))).toMatchObject({
      seat: "Kimi", status: "FAILED", errorCode: "INVALID_INTEGRATION_JSON",
      actualModel: "fixture-kimi", usage: { total: 120 }, rawContent,
    });
  });

  it("resumes successful Carbon evidence without calling any previous model adapter", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    const runDirectory = await seedCarbonResumeEvidence(store, carbonEvidenceFixture());
    let adapterCalls = 0;
    const adapter = async () => { adapterCalls += 1; throw new Error("must not call"); };
    const result = await runWeeklyReview({
      store, resume: runDirectory,
      fetchInputs: async () => { throw new Error("must not fetch new inputs"); },
      adapters: { astra: adapter, carbon: adapter, argon: adapter },
      integrator: async ({ models }: { models: Array<Record<string, unknown>> }) => {
        expect(models[1]).toMatchObject({
          seat: "Carbon", requestedModel: "gemini-4-carbon", actualModel: "gemini-4-carbon",
          requestedEffort: "HIGH", actualEffort: null, status: "SUCCESS", review: "Carbon周复盘正文",
          usage: { totalTokenCount: 30 }, output: path.join(runDirectory, "carbon.json"), productionChanges: false,
        });
        expect(models[1].outputSha256).toHaveLength(64);
        return {
          seat: "Kimi", status: "SUCCESS", actualModel: "fixture-kimi",
          review: { summary: "恢复Carbon证据", actions: [], dataGaps: ["Astra原文缺失"], stopped: [] },
        };
      },
      notifier: async () => {},
    });
    expect(adapterCalls).toBe(0);
    expect(result.report).toMatchObject({ runId: "carbon-resume-fixture", resumed: true, status: "COMPLETED_WITH_DECLARED_GAPS" });
  });

  it.each([
    {
      name: "execution failure",
      evidence: {
        ...carbonEvidenceFixture(), status: "FAILED", actualModel: "gemini-4-carbon",
        review: "partial", rawContent: "partial", finishReason: "MAX_TOKENS", error: "Carbon stopped at MAX_TOKENS",
      },
      errorCode: "CARBON_EXECUTION_FAILED",
    },
    {
      name: "invalid evidence",
      evidence: { ...carbonEvidenceFixture(), actualModel: "gemini-4-argon" },
      errorCode: "CARBON_EVIDENCE_INVALID",
    },
    { name: "missing evidence", evidence: null, errorCode: "CARBON_RAW_OUTPUT_MISSING" },
  ])("resumes Carbon $name with an explicit failure code", async ({ evidence, errorCode }) => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    const runDirectory = await seedCarbonResumeEvidence(store, evidence);
    let adapterCalls = 0;
    const adapter = async () => { adapterCalls += 1; throw new Error("must not call"); };
    const result = await runWeeklyReview({
      store, resume: runDirectory,
      fetchInputs: async () => { throw new Error("must not fetch new inputs"); },
      adapters: { astra: adapter, carbon: adapter, argon: adapter },
      integrator: async ({ models }: { models: Array<Record<string, unknown>> }) => {
        expect(models[1]).toMatchObject({
          seat: "Carbon", requestedModel: "gemini-4-carbon", status: "FAILED", errorCode,
          output: path.join(runDirectory, "carbon.json"), productionChanges: false,
        });
        return {
          seat: "Kimi", status: "SUCCESS", actualModel: "fixture-kimi",
          review: { summary: "保留Carbon失败", actions: [], dataGaps: [errorCode], stopped: [] },
        };
      },
      notifier: async () => {},
    });
    expect(adapterCalls).toBe(0);
    expect(result.report.status).toBe("COMPLETED_WITH_DECLARED_GAPS");
  });

  it("resumes historical Opus evidence without renaming it or calling model adapters", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    const runDirectory = await seedResumeEvidence(store);
    let adapterCalls = 0;
    const adapter = async () => { adapterCalls += 1; throw new Error("must not call"); };
    const result = await runWeeklyReview({
      store, resume: runDirectory,
      fetchInputs: async () => { throw new Error("must not fetch new inputs"); },
      adapters: { astra: adapter, carbon: adapter, argon: adapter },
      integrator: async ({ prompt, models }: { prompt: string; models: Array<Record<string, unknown>> }) => {
        expect(prompt).toBe("冻结的周复盘提示词\n");
        expect(models).toHaveLength(3);
        expect(models[0]).toMatchObject({ seat: "Astra", status: "FAILED", errorCode: "ASTRA_RAW_OUTPUT_MISSING", actualModel: null });
        expect(models[1]).toMatchObject({
          seat: "Opus", requestedModel: "claude-opus-5-5-high", status: "FAILED",
          errorCode: "OPUS_EXECUTION_FAILED", actualModel: null, actualEffort: "high",
          error: "Antigravity execution failed", output: path.join(runDirectory, "opus.json"),
        });
        expect(models[2]).toMatchObject({ seat: "Gemini", status: "SUCCESS", actualModel: "fixture-argon", actualEffort: null });
        return {
          seat: "Kimi", status: "SUCCESS", actualModel: "fixture-kimi",
          review: { summary: "只恢复最终整合", actions: [], dataGaps: ["Astra原文缺失"], stopped: [] },
        };
      },
      notifier: async () => {},
    });
    expect(adapterCalls).toBe(0);
    expect(result.report).toMatchObject({ runId: "resume-fixture", resumed: true, status: "COMPLETED_WITH_DECLARED_GAPS", productionChanges: false });
    expect(result.report.models).toHaveLength(4);
  });

  it("preserves the prior successful report when resumed integration fails", async () => {
    const store = new WeeklyReviewStore(path.join(directory, "weekly"));
    await store.begin("previous-success");
    await store.complete({
      runId: "previous-success", status: "COMPLETED", finishedAt: new Date().toISOString(),
      models: [], nextWeekActions: [], productionChanges: false,
    });
    await store.end();
    const runDirectory = await seedResumeEvidence(store);
    const published = await readFile(path.join(store.root, "latest-review.json"), "utf8");
    const success = await readFile(path.join(store.root, "last-success.json"), "utf8");
    await expect(runWeeklyReview({
      store, resume: runDirectory,
      fetchInputs: async () => { throw new Error("must not fetch new inputs"); },
      integrator: async ({ directory: outputDirectory }: { directory: string }) => persistKimiIntegration(outputDirectory, {
        content: '{"actions":[', parsed: null, model: "fixture-kimi",
        tokensUsed: { prompt: 100, completion: 20, total: 120 },
      }),
      notifier: async () => {},
    })).rejects.toMatchObject({ code: "INVALID_INTEGRATION_JSON" });
    expect(await readFile(path.join(store.root, "latest-review.json"), "utf8")).toBe(published);
    expect(await readFile(path.join(store.root, "last-success.json"), "utf8")).toBe(success);
    expect(JSON.parse(await readFile(path.join(store.root, "last-run.json"), "utf8"))).toMatchObject({ status: "failed", errorCode: "INVALID_INTEGRATION_JSON" });
    expect(JSON.parse(await readFile(path.join(runDirectory, "kimi-final.json"), "utf8")).rawContent).toBe('{"actions":[');
  });
});

function carbonEvidenceFixture() {
  return {
    requestedModel: "gemini-4-carbon", actualModel: "gemini-4-carbon",
    requestedThinkingLevel: "HIGH", actualThinkingLevel: null,
    createdAt: "2026-11-13T00:00:00.000Z", promptFile: path.resolve("prompt.txt"),
    promptSha256: sha256Text("Carbon周复盘提示词"), productionChanges: false,
    status: "SUCCESS", review: "Carbon周复盘正文", rawContent: "Carbon周复盘正文",
    usage: { promptTokenCount: 10, candidatesTokenCount: 20, totalTokenCount: 30 }, finishReason: "STOP",
  };
}

async function seedCarbonResumeEvidence(store: InstanceType<typeof WeeklyReviewStore>, evidence: Record<string, unknown> | null) {
  await store.begin("carbon-resume-fixture");
  const runDirectory = store.directory;
  const writes = [
    writeFile(path.join(runDirectory, "source.json"), JSON.stringify(sourceFixture())),
    writeFile(path.join(runDirectory, "competitor.json"), JSON.stringify(validCompetitor())),
    writeFile(path.join(runDirectory, "competitor-last-run.json"), JSON.stringify(validCompetitor())),
    writeFile(path.join(runDirectory, "prompt.txt"), "冻结的周复盘提示词\n"),
    writeFile(path.join(runDirectory, "model-route.json"), JSON.stringify({
      schemaVersion: 1, position: 2, seat: "Carbon", requestedModel: "gemini-4-carbon",
    })),
    writeFile(path.join(runDirectory, "argon.json"), JSON.stringify({
      requestedModel: "gemini-4-argon", actualModel: "fixture-argon", requestedEffort: "HIGH", actualEffort: null,
      status: "SUCCESS", review: "已保存的Argon评审", usage: { total_tokens: 20 },
    })),
  ];
  if (evidence) writes.push(writeFile(path.join(runDirectory, "carbon.json"), JSON.stringify(evidence)));
  await Promise.all(writes);
  await store.end();
  return runDirectory;
}

async function seedResumeEvidence(store: InstanceType<typeof WeeklyReviewStore>) {
  await store.begin("resume-fixture");
  const runDirectory = store.directory;
  await Promise.all([
    writeFile(path.join(runDirectory, "source.json"), JSON.stringify(sourceFixture())),
    writeFile(path.join(runDirectory, "competitor.json"), JSON.stringify(validCompetitor())),
    writeFile(path.join(runDirectory, "competitor-last-run.json"), JSON.stringify(validCompetitor())),
    writeFile(path.join(runDirectory, "prompt.txt"), "冻结的周复盘提示词\n"),
    writeFile(path.join(runDirectory, "opus.json"), JSON.stringify({
      model: "claude-opus-5-5-high", actualModel: null, effort: "high", exitCode: 1,
      validationError: "Antigravity execution failed", result: { status: "ERROR" }, toolsUsed: [],
    })),
    writeFile(path.join(runDirectory, "argon.json"), JSON.stringify({
      requestedModel: "gemini-4-argon", actualModel: "fixture-argon", requestedEffort: "HIGH", actualEffort: null,
      status: "SUCCESS", review: "已保存的Argon评审", usage: { total_tokens: 20 },
    })),
  ]);
  await store.end();
  return runDirectory;
}
