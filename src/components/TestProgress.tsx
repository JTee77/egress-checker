/** Fixed progress region for 测当前 / 测全部 — not only the primary button label. */

export type ProgressInfo = {
  /** Spoken phase, e.g.「连通性预检 3/40」or「检测 2/12（香港 01）」 */
  text: string;
  current?: number;
  total?: number;
  /** Node currently under cull/deep test — drives home-nodes highlight. */
  testingNode?: string;
};

export function TestProgress({ progress }: { progress: ProgressInfo }) {
  const { text, current, total } = progress;
  const hasRatio =
    typeof current === "number" &&
    typeof total === "number" &&
    total > 0 &&
    Number.isFinite(current) &&
    Number.isFinite(total);
  const pct = hasRatio
    ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
    : null;

  return (
    <div className="test-progress" role="status" aria-live="polite">
      <div className="test-progress-head">
        <span className="test-progress-text">{text}</span>
        {hasRatio ? (
          <span className="test-progress-ratio muted">
            {current}/{total}
          </span>
        ) : null}
      </div>
      <div
        className={`test-progress-bar${pct == null ? " test-progress-bar-indeterminate" : ""}`}
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={hasRatio ? total : 100}
        aria-valuenow={hasRatio ? current : undefined}
        aria-label={text}
      >
        <div
          className="test-progress-fill"
          style={pct != null ? { width: `${pct}%` } : undefined}
        />
      </div>
    </div>
  );
}
