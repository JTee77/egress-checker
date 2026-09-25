import type { CheckCard } from "../lib/egress/types";
import type { NodeScoreResult } from "../lib/score";
import type { ProxyNode } from "../lib/mihomo";
import { nodeCapabilityChips } from "../lib/mihomo";
import { StarRating } from "./StarRating";

/** level → 紧凑状态色类（与 app.css 的 .nc-* 对齐）。 */
function levelClass(level: CheckCard["level"]): string {
  switch (level) {
    case "pass":
      return "ok";
    case "warn":
      return "warn";
    case "fail":
      return "fail";
    case "running":
      return "run";
    default:
      return "unk";
  }
}

export function NodeCard({
  node,
  score,
  liveCards,
  isCurrent,
  expanded,
  testing,
  onToggle,
  onTest,
}: {
  node: ProxyNode;
  score?: NodeScoreResult;
  /** 正在检测该节点时的实时卡片（尚无最终评分时用于即时反馈）。 */
  liveCards?: CheckCard[];
  isCurrent: boolean;
  expanded: boolean;
  testing: boolean;
  onToggle: () => void;
  onTest: () => void;
}) {
  const chips = nodeCapabilityChips(node);
  // 判定"测过"看有没有评分结果（含"不可用"），而非有没有明细卡：
  // scoreDeadNode 返回 stars=不可用 但 cards=[]，旧逻辑会把它误显示为"未测"。
  const hasResult = !!score;
  const cards = score && score.cards.length > 0 ? score.cards : (liveCards ?? []);

  const action = hasResult ? (
    <button
      type="button"
      className="nc-act"
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
    >
      {expanded ? "收起 ▴" : "详情 ▾"}
    </button>
  ) : (
    <button
      type="button"
      className="nc-act"
      disabled={testing}
      onClick={(e) => {
        e.stopPropagation();
        onTest();
      }}
    >
      {testing ? "检测中…" : "测"}
    </button>
  );

  return (
    <div className={`ncard ${expanded ? "exp" : ""}`} onClick={onToggle}>
      <div className="nc-sum">
        <div className="nc-info">
          <div className="nc-name">
            <span className="nc-nm">{node.name}</span>
            {isCurrent ? <span className="nc-badge">使用中</span> : null}
          </div>
          <div className="nc-tags">
            {node.type}
            {chips.map((c) => (
              <span key={c} className="nc-chip">
                {c}
              </span>
            ))}
          </div>
        </div>
        <div className="nc-side">
          {hasResult ? (
            <StarRating stars={score!.stars} size={13} />
          ) : (
            <span className="nc-untested">{testing ? "检测中" : "未测"}</span>
          )}
          {action}
        </div>
      </div>

      {expanded && hasResult ? (
        <div className="nc-full">
          {cards.length ? (
            <div className="nc-grid">
              {cards.map((c) => (
                <div
                  key={c.id}
                  className="nc-cell"
                  title={c.conclusion ?? c.summary ?? undefined}
                >
                  <div className="nc-cl">
                    <span className={`nc-dot-mini ${levelClass(c.level)}`} />
                    <span className="nc-t">{c.title}</span>
                  </div>
                  <div className={`nc-cv ${levelClass(c.level)}`}>
                    {c.conclusion ?? c.summary ?? "—"}
                  </div>
                </div>
              ))}
            </div>
          ) : (
            <div className="nc-dead">{score!.blurb}</div>
          )}
        </div>
      ) : null}
    </div>
  );
}
