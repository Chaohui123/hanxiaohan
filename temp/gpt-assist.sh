#!/bin/bash
# gpt-assist.sh — 调用 Codex（GPT）辅助任务（Luna/Astra）
# 用法: temp/gpt-assist.sh <luna|astra> "<prompt>" [sandbox]
#   luna  = gpt-6-luna（批量文案/轻量分析）
#   astra = gpt-6-astra（推理档走 config；深度攻坚，不指定模型）
# Terra 现行工作已迁移到 Gemini 4 Hydrogen；terra 参数只返回迁移提示。
# sandbox（可选）: read-only（默认，只读分析）| workspace-write（需要改文件）
# 成本纪律：Astra 最稀缺，只在攻坚时用；批量文案用 luna。
# 生产红线：GPT 只做分析/生成，不直接操作生产数据。

set -e
TIER="${1:?用法: gpt-assist.sh <luna|astra> \"<prompt>\" [sandbox]}"
PROMPT="${2:?缺 prompt}"
SANDBOX="${3:-read-only}"

# Codex 网络链路：OpenAI 走住宅 IP 路由，Rust reqwest 读 HTTPS_PROXY 环境变量（v2rayN 必须已在跑）
export HTTPS_PROXY="${HTTPS_PROXY:-http://127.0.0.1:10808}"
export HTTP_PROXY="${HTTP_PROXY:-http://127.0.0.1:10808}"

MODEL_ARG=""
EFFORT_ARG=""
case "$TIER" in
  luna)  MODEL_ARG="-m gpt-6-luna" ;;
  terra) echo "Terra 已迁移到 Gemini 4 Hydrogen；请使用 scripts/gemini-hydrogen.py --prompt-file <文件> --output <JSON> [--image <图片>]" >&2; exit 2 ;;
  astra) MODEL_ARG="" ;;  # 走 config 的 gpt-6-astra 与实际推理档，不在包装层伪称 ultra
  *) echo "未知 tier: $TIER（可选 luna|astra）" >&2; exit 1 ;;
esac

cd /d/Onzo
echo "[gpt-assist] tier=$TIER sandbox=$SANDBOX model=${MODEL_ARG:-default} proxy=$HTTPS_PROXY" >&2
# npx 在线解析会卡死/并发死锁（2026-10-23 两路 luna 超时实证）：优先直调 npx 缓存里的 codex.exe
CODEXE=""
for candidate in "C:/Users/Administrator/AppData/Local/npm-cache/_npx/"*/node_modules/@openai/codex-win32-x64/vendor/x86_64-pc-windows-msvc/bin/codex.exe; do
  if [ -x "$candidate" ]; then CODEXE="$candidate"; break; fi
done
if [ -n "$CODEXE" ]; then CMD=("$CODEXE"); else CMD=(npx --yes @openai/codex); fi
# 省 token：分析类任务收窄上下文（GPT 会自己探索项目文件，烧 token）
PREFIX="（指令：只处理本 prompt 给定的内容/文件，不要通读项目文档或探索仓库——除非任务明确要求读某个具体文件。）"
if [ "$PROMPT" = "-" ]; then
  # stdin 传 prompt（长文本/多行安全，避免命令行截断）
  { printf '%s' "$PREFIX"; cat; } | "${CMD[@]}" exec $MODEL_ARG $EFFORT_ARG -s "$SANDBOX" --skip-git-repo-check -
else
  # shellcheck disable=SC2086
  exec "${CMD[@]}" exec $MODEL_ARG $EFFORT_ARG -s "$SANDBOX" --skip-git-repo-check "$PREFIX$PROMPT"
fi
