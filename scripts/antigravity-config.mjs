export const OPUS_MODEL = "claude-opus-5-5-high";
export const OPUS_EFFORT = "high";

function argument(argv, name, required = false) {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  if (required && (!value || value.startsWith("--"))) throw new Error(`${name} is required`);
  return value;
}

export function resolveAntigravityOptions(argv) {
  if (argv.includes("--dangerously-skip-permissions")) throw new Error("Skipping permissions is forbidden");
  const promptPath = argument(argv, "--prompt-file", true);
  const outputPath = argument(argv, "--output", true);
  const model = argument(argv, "--model") || OPUS_MODEL;
  const effort = argument(argv, "--effort") || OPUS_EFFORT;
  if (model !== OPUS_MODEL) throw new Error(`Only ${OPUS_MODEL} is allowed`);
  if (effort !== OPUS_EFFORT) throw new Error(`Only ${OPUS_EFFORT} effort is allowed`);
  return { promptPath, outputPath, model, effort, cwd: argument(argv, "--cwd") || process.cwd() };
}

export function antigravityResultError({ model, init, result, exitCode }) {
  if (exitCode !== 0 || result?.status !== "SUCCESS") return "Antigravity execution failed";
  if (init?.model !== model) return `Actual model ${init?.model || "unknown"} does not match ${model}`;
  if (init?.permission_mode !== "request-review") return `Unexpected permission mode ${init?.permission_mode || "unknown"}`;
  return null;
}
