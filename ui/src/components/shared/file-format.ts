import type { SessionFile } from "@/lib/models/session-model";

export function parseStatusLabel(file: SessionFile): string {
  const documentStatus = documentAnalysisLabel(file);
  switch (file.parseStatus) {
    case "parsed":
      return documentStatus ? `parsed ✓ · ${documentStatus}` : "parsed ✓";
    case "parsing":
      return "parsing…";
    case "error":
      return file.parserError ? `error: ${file.parserError}` : "parse error";
    default:
      return "uploaded";
  }
}

function documentAnalysisLabel(file: SessionFile): string | null {
  const analysis = file.documentAnalysis;
  if (!analysis || analysis.status === "not_needed") return null;
  if (analysis.status === "required") return "PDF reader needed";
  if (analysis.status === "reading") return "reading PDF…";
  if (analysis.status === "ready") {
    return analysis.provider && analysis.model
      ? `read by ${analysis.provider} / ${analysis.model}`
      : "PDF read ✓";
  }
  return analysis.error ? `PDF read failed: ${analysis.error}` : "PDF read failed";
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function documentReviewLabel(file: SessionFile): string {
  const review = file.documentReview;
  if (!review) return file.usedAt ? 'revision locked · review coverage unknown' : '';
  if (review.state === 'unavailable') return 'document content unavailable';
  if (review.pageCoverage === 'unknown') return review.state === 'complete' ? 'text processed · page coverage unknown' : 'text review incomplete';
  const pages = new Set([...review.reviewedPages, ...review.unresolvedPages]).size;
  return `${review.reviewedPages.length}/${pages} pages processed${review.state === 'complete' ? '' : ' · incomplete'}`;
}
