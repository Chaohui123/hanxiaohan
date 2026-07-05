import { ALL_VIOLATIONS, type Violation } from "./word-lists.js";

export interface AuditFinding {
  violation: Violation;
  position: number;
  context: string;
}

export interface AuditResult {
  passed: boolean;
  score: number;
  findings: AuditFinding[];
  blockedCount: number;
  warnCount: number;
  autoFixed: string;
  remainingIssues: AuditFinding[];
}

const SCORE_BASE = 100;
const SCORE_BLOCK_PENALTY = 15;
const SCORE_WARN_PENALTY = 5;

export function auditText(text: string, extraViolations?: Violation[]): AuditResult {
  const violations = extraViolations ? [...ALL_VIOLATIONS, ...extraViolations] : ALL_VIOLATIONS;
  const findings: AuditFinding[] = [];
  const lowerText = text.toLowerCase();

  for (const v of violations) {
    const lowerWord = v.word.toLowerCase();
    let searchFrom = 0;
    while (true) {
      const idx = lowerText.indexOf(lowerWord, searchFrom);
      if (idx === -1) break;
      const contextStart = Math.max(0, idx - 20);
      const contextEnd = Math.min(text.length, idx + v.word.length + 20);
      findings.push({
        violation: v,
        position: idx,
        context: text.slice(contextStart, contextEnd),
      });
      searchFrom = idx + 1;
    }
  }

  const blockedFindings = findings.filter((f) => f.violation.severity === "block");
  const warnFindings = findings.filter((f) => f.violation.severity === "warn");

  const score = Math.max(
    0,
    SCORE_BASE - blockedFindings.length * SCORE_BLOCK_PENALTY - warnFindings.length * SCORE_WARN_PENALTY,
  );

  const autoFixed = autoFixText(text, findings);

  const remainingIssues = auditTextInternal(autoFixed, violations);

  return {
    passed: blockedFindings.length === 0,
    score,
    findings,
    blockedCount: blockedFindings.length,
    warnCount: warnFindings.length,
    autoFixed,
    remainingIssues,
  };
}

function autoFixText(text: string, findings: AuditFinding[]): string {
  let result = text;
  const sorted = [...findings].sort((a, b) => b.position - a.position);

  for (const f of sorted) {
    if (f.violation.replacement === undefined) continue;
    if (f.violation.replacement === "") {
      result = result.slice(0, f.position) + result.slice(f.position + f.violation.word.length);
    } else {
      result =
        result.slice(0, f.position) +
        f.violation.replacement +
        result.slice(f.position + f.violation.word.length);
    }
  }

  return result;
}

function auditTextInternal(text: string, violations: Violation[]): AuditFinding[] {
  const lowerText = text.toLowerCase();
  const remaining: AuditFinding[] = [];
  for (const v of violations) {
    if (lowerText.includes(v.word.toLowerCase())) {
      remaining.push({
        violation: v,
        position: lowerText.indexOf(v.word.toLowerCase()),
        context: text.slice(
          Math.max(0, lowerText.indexOf(v.word.toLowerCase()) - 20),
          lowerText.indexOf(v.word.toLowerCase()) + v.word.length + 20,
        ),
      });
    }
  }
  return remaining;
}

export function formatAuditReport(result: AuditResult): string {
  const lines: string[] = [];

  if (result.passed) {
    lines.push(`✅ 合规审计通过 (评分 ${result.score}/100)`);
    if (result.warnCount > 0) {
      lines.push(`⚠️ ${result.warnCount} 条警告（建议修改但不阻断发布）`);
    }
  } else {
    lines.push(`🚫 合规审计未通过 (评分 ${result.score}/100)`);
    lines.push(`❌ ${result.blockedCount} 条阻断违规（必须修改后才能发布）`);
  }

  if (result.findings.length > 0) {
    lines.push("");
    lines.push("📋 违规详情：");
    for (const f of result.findings) {
      const icon = f.violation.severity === "block" ? "❌" : "⚠️";
      const fix = f.violation.replacement
        ? ` → 建议替换为: "${f.violation.replacement}"`
        : f.violation.replacement === ""
          ? " → 建议删除"
          : "";
      lines.push(`${icon} "${f.violation.word}" — ${f.violation.reason}${fix}`);
    }
  }

  if (result.findings.length > 0) {
    const fixedFindings = result.findings.filter((f) => f.violation.replacement !== undefined);
    if (fixedFindings.length > 0) {
      lines.push("");
      lines.push("🔧 已自动修复以下词汇：");
      for (const f of fixedFindings) {
        const arrow = f.violation.replacement ? `→ "${f.violation.replacement}"` : "→ (已删除)";
        lines.push(`  "${f.violation.word}" ${arrow}`);
      }
    }
  }

  if (result.remainingIssues.length > 0) {
    lines.push("");
    lines.push("⚠️ 自动修复后仍有问题，需人工审核：");
    for (const f of result.remainingIssues) {
      lines.push(`  "${f.violation.word}" — ${f.violation.reason}`);
    }
  }

  return lines.join("\n");
}
