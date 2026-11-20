import type { ReactNode } from "react";

export function BusyLabel({ children }: { children: ReactNode }) {
  return (
    <>
      <span className="busy-spinner" aria-hidden="true" />
      {children}
    </>
  );
}

export function SkeletonLines({
  lines = 3,
  className = "",
}: {
  lines?: number;
  className?: string;
}) {
  return (
    <div className={`skeleton-lines ${className}`.trim()} aria-hidden="true">
      {Array.from({ length: lines }, (_, index) => (
        <span key={index} className="skeleton-line" />
      ))}
    </div>
  );
}

export function PanelSkeleton({
  label = "正在读取…",
  lines = 4,
}: {
  label?: string;
  lines?: number;
}) {
  return (
    <div className="panel" aria-busy="true">
      <div className="panel-body skeleton-panel">
        <p className="skeleton-label">{label}</p>
        <SkeletonLines lines={lines} />
      </div>
    </div>
  );
}

export function AiProgress({ label, detail }: { label: string; detail?: string }) {
  return (
    <div className="ai-progress" role="progressbar" aria-label={label}>
      <div className="ai-progress-head">
        <span className="status-dot running" aria-hidden="true" />
        <span>{label}</span>
        {detail ? <span className="muted small">{detail}</span> : null}
      </div>
      <div className="ai-progress-track" aria-hidden="true">
        <span />
      </div>
    </div>
  );
}
