import { copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import {
  WeeklyReviewStore, modelFailure, parseIntegrationResponse, readJson,
  sha256File, sha256Text, validateCompetitorRun, validateSourceSnapshot,
} from "./weekly-review-core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
dotenv.config({ path: path.join(ROOT, ".env"), quiet: true });

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: options.cwd || ROOT, env: { ...process.env, ...options.env }, windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const fail = error => {
      if (settled) return;
      settled = true;
      reject(Object.assign(error instanceof Error ? error : new Error(String(error)), { command, stdout, stderr, exitCode: null }));
    };
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", chunk => { stdout += chunk; });
    child.stderr.on("data", chunk => { stderr += chunk; });
    child.on("error", fail);
    child.stdin.on("error", error => { if (error.code !== "EPIPE") fail(error); });
    if (options.input !== undefined) child.stdin.write(options.input);
    child.stdin.end();
    const timeout = setTimeout(() => {
      child.kill();
      fail(Object.assign(new Error(`Process timed out: ${command}`), { code: "PROCESS_TIMEOUT" }));
    }, options.timeoutMs || 120_000);
    child.on("close", code => {
      clearTimeout(timeout);
      if (settled) return;
      settled = true;
      const result = { code, stdout, stderr };
      if (code !== 0 && !options.allowNonzero) {
        reject(Object.assign(new Error(`${command} exited ${code}: ${stderr.slice(-500)}`), { code: "PROCESS_FAILED", command, stdout, stderr, exitCode: code }));
      } else resolve(result);
    });
  });
}

export async function fetchServerInputs(directory) {
  const files = [
    ["source.json", "/home/ubuntu/onzo/data/weekly-reviews/latest.json"],
    ["competitor.json", "/home/ubuntu/onzo/data/competitor-scans/latest.json"],
    ["competitor-last-run.json", "/home/ubuntu/onzo/data/competitor-scans/last-run.json"],
  ];
  for (const [name, remote] of files) {
    await runProcess("scp", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", `ubuntu@124.221.11.222:${remote}`, path.join(directory, name)], { timeoutMs: 60_000 });
  }
  const direct = path.join(ROOT, "temp", "direct-reports", "latest.json");
  let directPath = null;
  try {
    directPath = path.join(directory, "direct.json");
    await copyFile(direct, directPath);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    directPath = null;
  }
  return { source: path.join(directory, "source.json"), competitor: path.join(directory, "competitor.json"), lastRun: path.join(directory, "competitor-last-run.json"), direct: directPath };
}

export async function astraAdapter(prompt, directory, execute = runProcess) {
  const { writeFile } = await import("node:fs/promises");
  const command = process.env.GIT_BASH_PATH || "C:\\Program Files\\Git\\bin\\bash.exe";
  const output = path.join(directory, "astra.txt");
  const processOutput = path.join(directory, "astra-process.json");
  const startedAt = new Date().toISOString();
  const evidence = {
    seat: "Astra", command, arguments: ["temp/gpt-assist.sh", "astra", "-"],
    promptSha256: sha256Text(prompt), startedAt, productionChanges: false,
  };
  try {
    const result = await execute(command, evidence.arguments, { input: prompt, timeoutMs: 15 * 60_000, allowNonzero: true });
    await writeFile(processOutput, `${JSON.stringify({ ...evidence, finishedAt: new Date().toISOString(), exitCode: result.code, ...result }, null, 2)}\n`, "utf8");
    if (result.code !== 0) {
      throw Object.assign(new Error(`Astra process exited ${result.code}`), { code: "ASTRA_PROCESS_FAILED", ...result, exitCode: result.code });
    }
    if (!result.stdout.trim()) throw Object.assign(new Error("Astra returned no review text"), { code: "ASTRA_EMPTY_OUTPUT", ...result, exitCode: result.code });
    await writeFile(output, result.stdout, "utf8");
    const actualModel = result.stderr.match(/^model:\s*([^\r\n]+)/m)?.[1]?.trim() || null;
    const actualEffort = result.stderr.match(/^reasoning effort:\s*([^\r\n]+)/m)?.[1]?.trim() || null;
    const sessionId = result.stderr.match(/^session id:\s*([^\r\n]+)/m)?.[1]?.trim() || null;
    return {
      seat: "Astra", requestedModel: "gpt-6-astra", actualModel, actualEffort, sessionId,
      status: "SUCCESS", review: result.stdout.trim(), output, processOutput,
      note: actualModel ? "模型、档位和会话ID来自本次Codex CLI启动回执" : "本次CLI未返回模型元数据，不作推断",
      productionChanges: false,
    };
  } catch (error) {
    await writeFile(processOutput, `${JSON.stringify({
      ...evidence, finishedAt: new Date().toISOString(), exitCode: error.exitCode ?? null,
      stdout: error.stdout || "", stderr: error.stderr || "",
      error: { code: error.code || "ASTRA_PROCESS_FAILED", message: String(error.message || error).slice(0, 500) },
    }, null, 2)}\n`, "utf8");
    throw error;
  }
}

function carbonEvidenceError(evidence) {
  if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) return "Carbon evidence is not an object";
  if (evidence.status !== "SUCCESS") return "Carbon evidence status is not SUCCESS";
  if (evidence.requestedModel !== "gemini-4-carbon") return "Carbon evidence has an unexpected requested model";
  if (evidence.actualModel !== "gemini-4-carbon") return "Carbon evidence has an unexpected actual model";
  if (evidence.requestedThinkingLevel !== "HIGH") return "Carbon evidence has an unexpected requested thinking level";
  if (evidence.finishReason !== "STOP") return "Carbon evidence finishReason is not STOP";
  if (typeof evidence.review !== "string" || !evidence.review.trim()) return "Carbon evidence has no review text";
  if (evidence.productionChanges !== false) return "Carbon evidence must declare productionChanges=false";
  return null;
}

export async function carbonAdapter(promptPath, directory, execute = runProcess) {
  const output = path.join(directory, "carbon.json");
  let result;
  try {
    result = await execute("python", ["scripts/gemini-carbon-review.py", "--prompt-file", promptPath, "--output", output], { timeoutMs: 10 * 60_000, allowNonzero: true });
  } catch (error) {
    throw Object.assign(new Error(`Carbon execution failed: ${error.message}`), { code: "CARBON_EXECUTION_FAILED" });
  }
  let evidence;
  try {
    evidence = await readJson(output);
  } catch (error) {
    const missing = error.code === "ENOENT";
    throw Object.assign(new Error(missing ? "Carbon raw output was not saved" : `Carbon evidence is invalid: ${error.message}`), { code: missing ? "CARBON_RAW_OUTPUT_MISSING" : "CARBON_EVIDENCE_INVALID" });
  }
  if (result.code !== 0 || evidence?.status === "FAILED") {
    throw Object.assign(new Error(evidence?.error || `Carbon process exited ${result.code}`), { code: "CARBON_EXECUTION_FAILED" });
  }
  const evidenceError = carbonEvidenceError(evidence);
  if (evidenceError) throw Object.assign(new Error(evidenceError), { code: "CARBON_EVIDENCE_INVALID" });
  return {
    seat: "Carbon", requestedModel: "gemini-4-carbon", actualModel: evidence.actualModel,
    actualEffort: evidence.actualThinkingLevel ?? null, requestedEffort: evidence.requestedThinkingLevel,
    status: "SUCCESS", review: evidence.review.trim(), usage: evidence.usage, output,
    note: evidence.actualThinkingLevel ? "实际档位已回读" : "请求HIGH不代表实际档位已回读",
    productionChanges: false,
  };
}

async function argonAdapter(promptPath, directory) {
  const output = path.join(directory, "argon.json");
  const result = await runProcess("python", ["scripts/weekly-argon.py", "--prompt-file", promptPath, "--output", output], { timeoutMs: 10 * 60_000, allowNonzero: true });
  const evidence = await readJson(output);
  if (result.code !== 0 || evidence.status !== "SUCCESS") throw Object.assign(new Error(evidence.error || "Argon execution failed"), { code: "ARGON_EXECUTION_FAILED" });
  return {
    seat: "Gemini", requestedModel: evidence.requestedModel, actualModel: evidence.actualModel,
    actualEffort: evidence.actualEffort, requestedEffort: evidence.requestedEffort,
    status: "SUCCESS", review: evidence.review, usage: evidence.usage, output,
    note: evidence.actualEffort ? "实际档位已回读" : "Interactions实际文本已返回，档位元数据未返回，不伪称已验证HIGH",
    productionChanges: false,
  };
}

export async function persistKimiIntegration(directory, response) {
  const { writeFile } = await import("node:fs/promises");
  const output = path.join(directory, "kimi-final.json");
  const received = {
    seat: "Kimi", status: "RESPONSE_RECEIVED", actualModel: response.model,
    usage: response.tokensUsed, rawContent: response.content, productionChanges: false,
  };
  await writeFile(output, `${JSON.stringify(received, null, 2)}\n`, "utf8");
  try {
    const parsed = parseIntegrationResponse(response.parsed || response.content);
    const result = {
      seat: "Kimi", status: "SUCCESS", actualModel: response.model,
      usage: response.tokensUsed, review: parsed, productionChanges: false, output,
    };
    await writeFile(output, `${JSON.stringify({ ...result, rawContent: response.content }, null, 2)}\n`, "utf8");
    return result;
  } catch (error) {
    const failure = {
      ...received, status: "FAILED", errorCode: "INVALID_INTEGRATION_JSON",
      error: String(error?.message || error).slice(0, 500),
    };
    await writeFile(output, `${JSON.stringify(failure, null, 2)}\n`, "utf8");
    throw Object.assign(error, { code: "INVALID_INTEGRATION_JSON" });
  }
}

async function kimiIntegrator({ prompt, inputs, validation, models, directory }) {
  const { KimiVisionClient } = await import("../packages/ai/src/kimi-vision-client.ts");
  const source = await readFile(inputs.source, "utf8");
  const lastRun = await readJson(inputs.lastRun);
  const lastRunEvidence = Object.fromEntries(["runId", "startedAt", "completedAt", "source", "dryRun", "filters", "totals", "fatalError", "pendingReconciliation", "reconciliationErrors"].filter(key => key in lastRun).map(key => [key, lastRun[key]]));
  const modelEvidence = models.map(model => ({ ...model, review: typeof model.review === "string" ? model.review.slice(0, 50_000) : model.review }));
  const integrationPrompt = `你是Kimi，负责每周经营复盘的最终整合。你只能根据给定数据与真实模型回执形成结论，不调用工具、不改任何生产数据。不得把计划写成已完成，不得补造销量、转化、利润、竞品价格或模型调用。滚动7天不能直接相加；独立买家不跨周相加；NULL不是0；0转化时实际CPA不可计算，应写null而不是undefined或0；没有四个不重叠周窗口时不得冒充完整28天；28天本身不证明季节性。实际PROMO_AUTO_DECISION=false，Direct不扩品、不加预算、不改CPA。

请输出一个JSON对象，不要Markdown：{
  "summary":"中文经营结论",
  "actions":[{"priority":1,"action":"行动","owner":"负责人","deadline":"YYYY-MM-DD","completionCriteria":["可核验标准"]}],
  "dataGaps":["仍未解决的证据缺口"],
  "stopped":["明确不做事项"],
  "modelNotes":["模型回执纠偏"]
}
行动最多3项，每项必须有可在一周内验收的标准；证据不足时保留未知，不强行产生行动。

真实数据校验：${JSON.stringify(validation)}
原始经营输入：${source}
独立竞品运行回执（优先纠正旧提示词可能误报的lastRun缺失；失败计数不等于整个回执不存在）：${JSON.stringify(lastRunEvidence)}
共享评审提示词：${prompt}
真实模型回执（含失败，不得伪造）：${JSON.stringify(modelEvidence)}`;
  const client = new KimiVisionClient({
    apiKey: process.env.KIMI_API_KEY || "",
    baseUrl: process.env.KIMI_BASE_URL || "https://api.kimi.com/coding/v1",
    model: process.env.KIMI_VISION_MODEL || "kimi-k3",
    timeout: 180_000,
    maxRetries: 1,
  });
  const response = await client.chatCompletion({
    messages: [{ role: "user", content: integrationPrompt }],
    responseFormat: { type: "json_object" }, maxTokens: 6000,
  });
  return persistKimiIntegration(directory, response);
}

async function loadResumedContext(directory) {
  const inputs = {
    source: path.join(directory, "source.json"),
    competitor: path.join(directory, "competitor.json"),
    lastRun: path.join(directory, "competitor-last-run.json"),
    direct: path.join(directory, "direct.json"),
  };
  let prompt;
  try {
    prompt = await readFile(path.join(directory, "prompt.txt"), "utf8");
    await Promise.all([inputs.source, inputs.competitor, inputs.lastRun].map(file => readJson(file)));
  } catch (error) {
    throw Object.assign(new Error(`Resume evidence is incomplete: ${error.message}`), { code: "RESUME_EVIDENCE_INCOMPLETE" });
  }
  try {
    await readJson(inputs.direct);
  } catch (error) {
    if (error.code !== "ENOENT") throw Object.assign(new Error(`Resumed Direct report is invalid: ${inputs.direct}`), { code: "RESUME_EVIDENCE_INCOMPLETE" });
    inputs.direct = null;
  }
  if (!prompt.trim()) throw Object.assign(new Error("Resumed weekly prompt is empty"), { code: "RESUME_EVIDENCE_INCOMPLETE" });
  let carbonRoute = false;
  try {
    const route = await readJson(path.join(directory, "model-route.json"));
    if (route?.schemaVersion !== 1 || route?.position !== 2 || route?.seat !== "Carbon" || route?.requestedModel !== "gemini-4-carbon") {
      throw new Error("Unsupported weekly review model route");
    }
    carbonRoute = true;
  } catch (error) {
    if (error.code === "ENOENT") carbonRoute = false;
    else throw Object.assign(new Error(`Resume model route is invalid: ${error.message}`), { code: "RESUME_EVIDENCE_INCOMPLETE" });
  }
  const definitions = [
    {
      seat: "Astra", name: "astra.txt", missingCode: "ASTRA_RAW_OUTPUT_MISSING",
      parse: text => {
        if (!text.trim()) throw Object.assign(new Error("Astra raw output is empty"), { code: "ASTRA_RAW_OUTPUT_EMPTY" });
        return {
          seat: "Astra", requestedModel: "gpt-6-astra", actualModel: null, actualEffort: null,
          status: "SUCCESS", review: text.trim(), productionChanges: false,
          note: "恢复已保存的原始输出；没有实际模型或档位元数据，不作推断",
        };
      },
    },
    carbonRoute ? {
      seat: "Carbon", name: "carbon.json", requestedModel: "gemini-4-carbon", missingCode: "CARBON_RAW_OUTPUT_MISSING",
      parse: text => {
        const evidence = JSON.parse(text);
        const base = {
          seat: "Carbon", requestedModel: evidence?.requestedModel || "gemini-4-carbon",
          actualModel: evidence?.actualModel ?? null, actualEffort: evidence?.actualThinkingLevel ?? null,
          requestedEffort: evidence?.requestedThinkingLevel ?? null, productionChanges: false,
          usage: evidence?.usage ?? null,
        };
        if (evidence?.status === "FAILED") {
          return {
            ...base, status: "FAILED", errorCode: "CARBON_EXECUTION_FAILED",
            error: evidence.error || "Saved Carbon execution failed", finishReason: evidence.finishReason ?? null,
          };
        }
        const evidenceError = carbonEvidenceError(evidence);
        if (evidenceError) {
          return { ...base, status: "FAILED", errorCode: "CARBON_EVIDENCE_INVALID", error: evidenceError };
        }
        return {
          ...base, status: "SUCCESS", review: evidence.review.trim(),
          note: evidence.actualThinkingLevel ? "实际档位已回读" : "请求HIGH不代表实际档位已回读",
        };
      },
    } : {
      seat: "Opus", name: "opus.json", missingCode: "OPUS_RAW_OUTPUT_MISSING",
      parse: text => {
        const evidence = JSON.parse(text);
        const base = {
          seat: "Opus", requestedModel: evidence.model || "claude-opus-5-5-high",
          actualModel: evidence.actualModel ?? null, actualEffort: evidence.effort ?? null,
          productionChanges: false, toolsUsed: evidence.toolsUsed || [],
        };
        if (evidence.exitCode !== 0 || evidence.validationError) {
          return {
            ...base, status: "FAILED", errorCode: "OPUS_EXECUTION_FAILED",
            error: evidence.validationError || evidence.result?.error || "Saved Opus execution failed",
            result: evidence.result ?? null, exitCode: evidence.exitCode ?? null,
          };
        }
        return { ...base, status: "SUCCESS", review: evidence.result, permissionMode: evidence.init?.permission_mode };
      },
    },
    {
      seat: "Gemini", name: "argon.json", missingCode: "ARGON_RAW_OUTPUT_MISSING",
      parse: text => {
        const evidence = JSON.parse(text);
        const base = {
          seat: "Gemini", requestedModel: evidence.requestedModel || "gemini-4-argon",
          actualModel: evidence.actualModel ?? null, actualEffort: evidence.actualEffort ?? null,
          requestedEffort: evidence.requestedEffort ?? null, productionChanges: false,
        };
        if (evidence.status !== "SUCCESS" || !evidence.review) {
          return {
            ...base, status: "FAILED",
            errorCode: evidence.status === "FAILED" ? "ARGON_EXECUTION_FAILED" : "ARGON_EVIDENCE_INVALID",
            error: evidence.error || "Saved Argon evidence has no review text", usage: evidence.usage,
          };
        }
        return {
          ...base, status: "SUCCESS", review: evidence.review, usage: evidence.usage,
          note: evidence.actualEffort ? "实际档位已回读" : "Interactions实际文本已返回，档位元数据未返回，不伪称已验证HIGH",
        };
      },
    },
  ];
  const models = await Promise.all(definitions.map(async definition => {
    const output = path.join(directory, definition.name);
    try {
      const text = await readFile(output, "utf8");
      return { ...definition.parse(text), output, outputSha256: sha256Text(text) };
    } catch (error) {
      return {
        seat: definition.seat, status: "FAILED", actualModel: null,
        ...(definition.requestedModel ? { requestedModel: definition.requestedModel } : {}),
        errorCode: error.code === "ENOENT" ? definition.missingCode : definition.seat === "Carbon" ? "CARBON_EVIDENCE_INVALID" : error.code || "SAVED_MODEL_EVIDENCE_INVALID",
        error: error.code === "ENOENT" ? `${definition.seat} raw output was not saved; no content is inferred` : String(error.message || error).slice(0, 500),
        output, productionChanges: false,
      };
    }
  }));
  return { inputs, prompt, models };
}

async function notifyFailure(runId, error) {
  try {
    const { emitEvent } = await import("../apps/api-services/src/services/notification-events.ts");
    await emitEvent("WEEKLY_REVIEW_FAILED", { runId, error: String(error?.message || error).slice(0, 300) });
  } catch {
    // The failed run remains on disk even if notification is unavailable.
  }
}

export async function runWeeklyReview(options = {}) {
  const now = options.now || new Date();
  const store = options.store || new WeeklyReviewStore(path.join(ROOT, "data", "weekly-reviews"));
  let runId = `weekly-${now.toISOString().replace(/[:.]/g, "-")}`;
  if (options.resume) {
    await store.resume(path.resolve(ROOT, options.resume));
    runId = store.runId;
  } else {
    await store.begin(runId);
  }
  try {
    if (!options.resume) {
      await store.writeJsonArtifact("model-route.json", {
        schemaVersion: 1, position: 2, seat: "Carbon", requestedModel: "gemini-4-carbon",
      });
    }
    const resumed = options.resume ? await loadResumedContext(store.directory) : null;
    const inputs = resumed?.inputs || await (options.fetchInputs || fetchServerInputs)(store.directory);
    const source = await readJson(inputs.source);
    const validation = {
      source: validateSourceSnapshot(source, now),
      competitor: validateCompetitorRun(await readJson(inputs.competitor), await readJson(inputs.lastRun), now),
    };
    let prompt = resumed?.prompt;
    let promptPath = path.join(store.directory, "prompt.txt");
    if (!resumed) {
      const promptArgs = ["scripts/weekly-model-prompt.py", "--source", inputs.source, "--competitor-report", inputs.competitor, "--competitor-last-run", inputs.lastRun];
      if (inputs.direct) promptArgs.push("--direct-report", inputs.direct);
      const promptResult = await runProcess("python", promptArgs, { timeoutMs: 60_000 });
      prompt = promptResult.stdout;
      if (!prompt.trim()) throw new Error("Weekly prompt generation returned no content");
      promptPath = await store.writeArtifact("prompt.txt", prompt);
    }
    let models;
    if (resumed) {
      models = resumed.models;
    } else {
      const adapters = options.adapters || { astra: astraAdapter, carbon: carbonAdapter, argon: argonAdapter };
      const settled = await Promise.allSettled([
        adapters.astra(prompt, store.directory),
        adapters.carbon(promptPath, store.directory),
        adapters.argon(promptPath, store.directory),
      ]);
      const seats = ["Astra", "Carbon", "Gemini"];
      models = settled.map((item, index) => item.status === "fulfilled" ? item.value : { seat: seats[index], ...modelFailure(item.reason), productionChanges: false });
      for (const model of models) {
        if (model.output) model.outputSha256 = await sha256File(model.output);
      }
    }
    const integration = await (options.integrator || kimiIntegrator)({ prompt, inputs, validation, models, directory: store.directory });
    const parsed = integration.review;
    const completed = {
      schemaVersion: 1,
      runId,
      reviewDate: now.toISOString().slice(0, 10),
      startedAt: now.toISOString(),
      finishedAt: new Date().toISOString(),
      resumed: Boolean(resumed),
      status: models.some(model => model.status !== "SUCCESS") || validation.source.stale || !validation.competitor.usable ? "COMPLETED_WITH_DECLARED_GAPS" : "COMPLETED",
      readOnly: true,
      productionChanges: false,
      operationsPeriod: source.operationsPeriod,
      inputValidation: validation,
      nextWeekActions: parsed.actions,
      summary: parsed.summary || "",
      dataGaps: parsed.dataGaps || [],
      stopped: parsed.stopped || parsed.doNotExecute || [],
      modelNotes: parsed.modelNotes || [],
      models: [...models, integration],
      evidence: {
        ...Object.fromEntries(Object.entries(inputs).filter(([, value]) => value).map(([key, value]) => [key, value])),
        prompt: promptPath,
        promptSha256: sha256Text(prompt),
        integrationOutput: integration.output || path.join(store.directory, "kimi-final.json"),
      },
      note: "由独立Windows系统任务执行，不依赖Kimi会话；数据陈旧或模型失败必须明确标注，不能冒充全量成功。",
    };
    const published = await store.complete(completed);
    return { ...published, report: completed };
  } catch (error) {
    await store.fail(error);
    await (options.notifier || notifyFailure)(runId, error);
    throw error;
  } finally {
    await store.end();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length && (args.length !== 2 || args[0] !== "--resume" || !args[1])) {
    console.error("Usage: node --import tsx scripts/weekly-review-runner.mjs [--resume <existing-run-directory>]");
    process.exitCode = 1;
  } else {
    runWeeklyReview({ resume: args[1] }).then(result => {
      console.log(JSON.stringify({ runId: result.report.runId, status: result.report.status, reportPath: result.reportPath, contentSha256: result.contentSha256, productionChanges: false }, null, 2));
    }).catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
  }
}
