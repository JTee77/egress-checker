import { useState } from "react";
import type { CheckCard } from "../lib/egress/types";
import { StatusBadge } from "./StatusBadge";

export function CheckCardView({ card }: { card: CheckCard }) {
  const conclusion = card.conclusion ?? card.summary ?? "尚未检测";
  const process = card.process ?? card.detail;
  const suggestion = card.suggestion ?? card.tip;
  const [processOpen, setProcessOpen] = useState(false);
  const hasProcess = !!(process && process.trim());

  return (
    <article className="card card-dense">
      <div className="card-top">
        <h3>{card.title}</h3>
        <StatusBadge level={card.level} conclusion={conclusion} />
      </div>
      <div className="card-conclusion">{conclusion}</div>
      {suggestion ? <div className="card-suggestion">{suggestion}</div> : null}
      {hasProcess ? (
        <>
          <button
            type="button"
            className="card-process-toggle"
            aria-expanded={processOpen}
            onClick={() => setProcessOpen((v) => !v)}
          >
            {processOpen ? "收起过程" : "查看过程"}
          </button>
          {processOpen ? <div className="card-process">{process}</div> : null}
        </>
      ) : null}
    </article>
  );
}
