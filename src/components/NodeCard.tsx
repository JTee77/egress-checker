import { useEffect, useMemo, useState } from "react";
import type { CheckCard } from "../lib/egress/types";
import { formatCardBrief } from "../lib/egress/cardBrief";
import {
  isServiceSummaryId,
  summarizeServiceCards,
} from "../lib/egress/serviceSummary";
import type { NodeScoreResult } from "../lib/score";
import type { ProxyNode } from "../lib/mihomo";
import { nodeCapabilityChips } from "../lib/mihomo";
import { StarRating } from "./StarRating";
import { StatusBadge } from "./StatusBadge";

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

const EMPTY_METRIC_TITLES = ["连通性", "出口 IP", "延迟", "带宽", "流媒体", "AI", "商店"];

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
  const rawCards = score && score.cards.length > 0 ? score.cards : (liveCards ?? []);
  // 卡墙：流媒体 / AI / 商店合成汇总；评分仍用原始单项卡。
  const cards = useMemo(() => summarizeServiceCards(rawCards), [rawCards]);
  const [detailId, setDetailId] = useState<string | null>(null);
  const [processOpen, setProcessOpen] = useState(false);

  // 收起摘要墙时关掉外置详情，避免悬空面板。
  useEffect(() => {
    if (!expanded) setDetailId(null);
  }, [expanded]);

  // 卡片集合变了（再测 / 切节点结果）时，清掉已不存在的选中项。
  useEffect(() => {
    if (detailId && !cards.some((c) => c.id === detailId)) setDetailId(null);
  }, [cards, detailId]);

  // 换详情项时收起过程，默认不对用户展示测法。
  useEffect(() => {
    setProcessOpen(false);
  }, [detailId]);

  const detailCard = detailId ? cards.find((c) => c.id === detailId) : undefined;
  const detailProcess = detailCard?.process ?? detailCard?.detail;
  const hasProcess = !!(detailProcess && detailProcess.trim());
  // 汇总卡徽章用「全通/部分/…」；其它卡仍用 conclusion。
  const detailBadgeConclusion = detailCard
    ? isServiceSummaryId(detailCard.id)
      ? formatCardBrief(detailCard)
      : (detailCard.conclusion ?? detailCard.summary)
    : undefined;

  const action = hasResult ? (
    <div className="nc-acts">
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
      <button
        type="button"
        className="nc-act"
        disabled={testing}
        onClick={(e) => {
          e.stopPropagation();
          onTest();
        }}
      >
        {testing ? "检测中…" : "再测"}
      </button>
    </div>
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
    <div className="nc-wrap">
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

        {expanded ? (
          <div className="nc-full">
            {cards.length ? (
              <div className="nc-grid">
                {cards.map((c) => {
                  const brief = formatCardBrief(c);
                  const on = detailId === c.id;
                  return (
                    <button
                      key={c.id}
                      type="button"
                      className={`nc-cell${on ? " on" : ""}`}
                      title={brief}
                      onClick={(e) => {
                        e.stopPropagation();
                        setDetailId((prev) => (prev === c.id ? null : c.id));
                      }}
                    >
                      <div className="nc-cl">
                        <span className={`nc-dot-mini ${levelClass(c.level)}`} />
                        <span className="nc-t">{c.title}</span>
                      </div>
                      <div className={`nc-cv ${levelClass(c.level)}`}>{brief}</div>
                    </button>
                  );
                })}
              </div>
            ) : score ? (
              <div className="nc-dead">{score.blurb}</div>
            ) : (
              <div className="nc-grid nc-grid-empty" aria-label="暂无检测详情">
                {EMPTY_METRIC_TITLES.map((title) => (
                  <div key={title} className="nc-cell nc-cell-empty" aria-hidden="true">
                    <div className="nc-cl">
                      <span className="nc-dot-mini unk" />
                      <span className="nc-t">{title}</span>
                    </div>
                    <div className="nc-cv unk">—</div>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}
      </div>

      {detailCard ? (
        <aside
          className="nc-detail"
          role="dialog"
          aria-label={`${detailCard.title} 详情`}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="nc-detail-top">
            <div className="nc-detail-head">
              <span className="nc-detail-title">{detailCard.title}</span>
              <StatusBadge
                level={detailCard.level}
                conclusion={detailBadgeConclusion}
              />
            </div>
            <button
              type="button"
              className="nc-detail-close"
              aria-label="关闭详情"
              onClick={(e) => {
                e.stopPropagation();
                setDetailId(null);
              }}
            >
              ×
            </button>
          </div>
          <div className="nc-detail-conclusion">
            {detailCard.conclusion ?? detailCard.summary ?? "—"}
          </div>
          {detailCard.suggestion ?? detailCard.tip ? (
            <div className="nc-detail-suggestion">
              {detailCard.suggestion ?? detailCard.tip}
            </div>
          ) : null}
          {hasProcess ? (
            <>
              <button
                type="button"
                className="nc-detail-process-toggle"
                aria-expanded={processOpen}
                onClick={(e) => {
                  e.stopPropagation();
                  setProcessOpen((v) => !v);
                }}
              >
                {processOpen ? "收起过程" : "查看过程"}
              </button>
              {processOpen ? (
                <pre className="nc-detail-process">{detailProcess}</pre>
              ) : null}
            </>
          ) : null}
        </aside>
      ) : null}
    </div>
  );
}
