export type PageId = "home" | "nodes" | "settings" | "about";

const ITEMS: { id: PageId; label: string }[] = [
  { id: "home", label: "首页" },
  { id: "nodes", label: "节点" },
  { id: "settings", label: "设置" },
  { id: "about", label: "关于" },
];

export function Sidebar({
  page,
  onNavigate,
}: {
  page: PageId;
  onNavigate: (id: PageId) => void;
}) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-title">Egress Checker</div>
        <div className="brand-sub">出口质量检测</div>
      </div>
      {ITEMS.map((item) => (
        <button
          key={item.id}
          className={`nav-btn${page === item.id ? " active" : ""}`}
          onClick={() => onNavigate(item.id)}
          type="button"
        >
          {item.label}
        </button>
      ))}
    </aside>
  );
}
