import { useState } from "react";
import { Sidebar, type PageId } from "./components/Sidebar";
import { HomePage } from "./pages/HomePage";
import { NodesPage } from "./pages/NodesPage";
import { SettingsPage } from "./pages/SettingsPage";
import { AboutPage } from "./pages/AboutPage";
import { useConnection } from "./hooks/useConnection";
import "./styles/app.css";

function App() {
  const [page, setPage] = useState<PageId>("home");
  const {
    state,
    nodes,
    busy,
    manual,
    forceMock,
    clientId,
    setClientId,
    updateManual,
    resetManual,
    refresh,
    setForceMock,
  } = useConnection();

  return (
    <div className="app-shell">
      <Sidebar page={page} onNavigate={setPage} />
      <main className="main">
        {page === "home" ? (
          <HomePage
            connection={state}
            busy={busy}
            clientId={clientId}
            onClientIdChange={setClientId}
            onRefresh={() => refresh()}
            onNavigateToSettings={() => setPage("settings")}
          />
        ) : null}
        {page === "nodes" ? (
          <NodesPage connection={state} nodes={nodes} onSwitched={() => void refresh()} />
        ) : null}
        {page === "settings" ? (
          <SettingsPage
            connection={state}
            manual={manual}
            busy={busy}
            forceMock={forceMock}
            clientId={clientId}
            onChangeManual={updateManual}
            onResetManual={resetManual}
            onForceMockChange={(v) => {
              setForceMock(v);
              void refresh(undefined, v);
            }}
            onRefresh={(override) => refresh(override)}
          />
        ) : null}
        {page === "about" ? <AboutPage /> : null}
      </main>
    </div>
  );
}

export default App;
