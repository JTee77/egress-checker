import type { CheckCard } from "../lib/egress/types";
import { StatusBadge } from "./StatusBadge";

export function CheckCardView({ card }: { card: CheckCard }) {
  return (
    <article className="card">
      <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
        <h3>{card.title}</h3>
        <StatusBadge level={card.level} />
      </div>
      <div className="card-summary">{card.summary}</div>
      {card.detail ? <div className="card-detail">{card.detail}</div> : null}
      {card.tip ? <div className="card-tip">{card.tip}</div> : null}
    </article>
  );
}
