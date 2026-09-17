import { useState } from "react";
import type { CheckCard } from "../lib/egress/types";
import { StatusBadge } from "./StatusBadge";

export function CheckCardView({ card }: { card: CheckCard }) {
  const hasMore = !!(card.detail || card.tip);
  const [open, setOpen] = useState(false);

  return (
    <article className={`card card-compact${open ? " is-open" : ""}`}>
      <div className="card-top">
        <h3>{card.title}</h3>
        <StatusBadge level={card.level} />
      </div>
      <div className="card-summary">{card.summary}</div>
      {hasMore ? (
        <button
          type="button"
          className="card-expand"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "收起详情" : "展开详情"}
        </button>
      ) : null}
      {open && card.detail ? <div className="card-detail">{card.detail}</div> : null}
      {open && card.tip ? <div className="card-tip">{card.tip}</div> : null}
    </article>
  );
}
