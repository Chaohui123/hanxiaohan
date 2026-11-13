import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { spawn } from "node:child_process";
import { antigravityResultError, resolveAntigravityOptions } from "./antigravity-config.mjs";

const { promptPath, outputPath, model, effort, cwd } = resolveAntigravityOptions(process.argv);
const executable = process.env.AGY_BIN || path.join(process.env.LOCALAPPDATA || "", "agy", "bin", "agy.exe");
const prompt = await readFile(promptPath, "utf8");
const args = ["--input-format", "stream-json", "--output-format", "stream-json", "--effort", effort, "--sandbox"];
if (model) args.push("--model", model);
const child = spawn(executable, args, {
  cwd,
  env: {
    ...process.env,
    HTTPS_PROXY: process.env.HTTPS_PROXY || "http://127.0.0.1:10808",
    HTTP_PROXY: process.env.HTTP_PROXY || "http://127.0.0.1:10808",
  },
  stdio: ["pipe", "pipe", "pipe"],
});
let stdout = "";
let stderr = "";
let init = null;
let result = null;
let eventCount = 0;
const toolsUsed = [];
child.stdout.setEncoding("utf8");
child.stderr.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  stdout += chunk;
  let boundary;
  while ((boundary = stdout.indexOf("\n")) >= 0) {
    const line = stdout.slice(0, boundary).trim();
    stdout = stdout.slice(boundary + 1);
    if (!line) continue;
    try {
      const event = JSON.parse(line);
      eventCount++;
      if (event.event === "init") init = event.init;
      if (event.event === "result") result = event.result;
      if (event.event === "step_update" && event.step_update?.step_type === "tool") toolsUsed.push(event.step_update.tool_name);
    } catch {
      stderr += `Non-JSON CLI output: ${line.slice(0, 300)}\n`;
    }
  }
});
child.stderr.on("data", (chunk) => { stderr += chunk; });
child.stdin.on("error", (error) => { if (error.code !== "EPIPE") stderr += `${error.message}\n`; });
child.stdin.write(`${JSON.stringify({ event: "user", message: { content: prompt } })}\n`);
child.stdin.end();
const timeout = setTimeout(() => child.kill(), 15 * 60 * 1000);
const exitCode = await new Promise((resolve, reject) => {
  child.on("error", reject);
  child.on("close", resolve);
});
clearTimeout(timeout);
const validationError = antigravityResultError({ model, init, result, exitCode });
const evidence = {
  source: "Google Antigravity CLI",
  model,
  actualModel: init?.model || null,
  effort,
  sandbox: true,
  promptFile: promptPath,
  cwd,
  init,
  result,
  eventCount,
  toolsUsed: [...new Set(toolsUsed)],
  exitCode,
  validationError,
  stderr: validationError ? `${validationError}\n${stderr}`.slice(-1000) : null,
};
await writeFile(outputPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ model: evidence.model, actualModel: evidence.actualModel, effort, status: validationError ? "ERROR" : "SUCCESS", exitCode, conversationId: result?.conversation_id || null, output: outputPath }));
if (validationError) process.exitCode = 1;
