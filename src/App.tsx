import { HomePage } from "./pages/HomePage";
import { useConnection } from "./hooks/useConnection";
import "./styles/app.css";

function App() {
  const {
    state,
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
      <main className="main">
        <HomePage
          connection={state}
          busy={busy}
          clientId={clientId}
          onClientIdChange={setClientId}
          onRefresh={() => refresh()}
          manual={manual}
          forceMock={forceMock}
          onChangeManual={updateManual}
          onResetManual={resetManual}
          onForceMockChange={(v) => {
            setForceMock(v);
            void refresh(undefined, v);
          }}
          onRefreshAdvanced={(override) => refresh(override)}
        />
      </main>
    </div>
  );
}

export default App;
