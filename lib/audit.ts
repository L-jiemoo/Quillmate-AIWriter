import type { AuditChapterResult, AuditResult, ContinuityIssue } from "./types";

const CHAPTER_HEADING = /^##\s+第\s*(\d+)\s*章\s*《(.+)》\s*$/;
const ISSUE_LINE = /^-\s*\*\*(严重|建议|可忽略)\s*·\s*(.+?)\*\*：(.+)$/;
const EVIDENCE_LINE = /^\s*-\s*证据：(.+)$/;

// 总体审校报告由 runAudit 生成，格式固定；这里把它还原成与章节审校一致的结构。
// 保留 Markdown 作为报告文件，同时让页面可以按章展示严重/建议与证据。
export function parseAuditReport(content: string): AuditResult {
  const chapters: AuditChapterResult[] = [];
  let current: AuditChapterResult | null = null;
  let lastIssue: ContinuityIssue | null = null;

  const finishChapter = () => {
    if (current) chapters.push(current);
    current = null;
    lastIssue = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    const chapterMatch = line.match(CHAPTER_HEADING);
    if (chapterMatch) {
      finishChapter();
      current = {
        index: Number(chapterMatch[1]),
        title: chapterMatch[2].trim(),
        issues: [],
      };
      continue;
    }
    if (!current || !line.trim()) continue;
    if (line.includes("未发现明显连续性问题")) continue;

    const issueMatch = line.match(ISSUE_LINE);
    if (issueMatch) {
      lastIssue = {
        severity:
          issueMatch[1] === "严重"
            ? "critical"
            : issueMatch[1] === "可忽略"
              ? "ignore"
              : "warning",
        type: issueMatch[2].trim() || "其他",
        detail: issueMatch[3].trim(),
        evidence: "",
      };
      current.issues.push(lastIssue);
      continue;
    }

    const evidenceMatch = line.match(EVIDENCE_LINE);
    if (evidenceMatch && lastIssue) {
      lastIssue.evidence = evidenceMatch[1].trim();
      continue;
    }

    // 旧报告里模型输出的详情可能带换行；把无法识别的续行并入上一条，避免丢内容。
    if (lastIssue) {
      lastIssue.detail = `${lastIssue.detail} ${line.trim()}`.trim();
    }
  }
  finishChapter();

  const critical = chapters.reduce(
    (sum, chapter) =>
      sum + chapter.issues.filter((issue) => issue.severity === "critical").length,
    0,
  );
  const warnings = chapters.reduce(
    (sum, chapter) =>
      sum + chapter.issues.filter((issue) => issue.severity === "warning").length,
    0,
  );
  const ignored = chapters.reduce(
    (sum, chapter) =>
      sum + chapter.issues.filter((issue) => issue.severity === "ignore").length,
    0,
  );
  return { chapters, critical, warnings, ignored };
}
