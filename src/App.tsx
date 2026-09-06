import { useMemo, useState } from "react";
import { detectRuntimeCapabilities } from "./capabilities/detect-runtime-capabilities";

type SelectedMode = "sqlite" | "postgresql";

const architectureSteps = [
  { index: "01", title: "Migration files", detail: "revision code를 직접 편집합니다." },
  { index: "02", title: "Revision DAG", detail: "branch와 current 위치를 추적합니다." },
  { index: "03", title: "Actual schema", detail: "실제 DB 변화와 diff를 확인합니다." },
];

export default function App() {
  const capabilities = useMemo(() => detectRuntimeCapabilities(), []);
  const [selectedMode, setSelectedMode] = useState<SelectedMode>("sqlite");

  return (
    <main>
      <header className="site-header">
        <a className="brand" href="./" aria-label="Revision Lab 홈">
          <span className="brand-mark" aria-hidden="true">
            RL
          </span>
          <span>Revision Lab</span>
        </a>
        <span className="stage-label">Foundation · T1</span>
      </header>

      <section className="hero" aria-labelledby="hero-title">
        <div className="hero-copy">
          <p className="eyebrow">Alembic Migration Playground</p>
          <h1 id="hero-title">
            Migration을 실행하고,
            <br />
            <span>변화를 눈으로 확인하세요.</span>
          </h1>
          <p className="hero-description">
            revision 파일, Alembic DAG, 실제 데이터베이스 schema가 어떻게 함께 움직이는지
            브라우저 안에서 직접 실험하는 학습 환경입니다.
          </p>
        </div>

        <div className="flow-card" aria-label="Revision Lab 학습 흐름">
          {architectureSteps.map((step, position) => (
            <div className="flow-row" key={step.index}>
              <span className="step-index">{step.index}</span>
              <div>
                <strong>{step.title}</strong>
                <p>{step.detail}</p>
              </div>
              {position < architectureSteps.length - 1 && <span className="flow-line" />}
            </div>
          ))}
        </div>
      </section>

      <section className="environment-section" aria-labelledby="environment-title">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Runtime readiness</p>
            <h2 id="environment-title">이 브라우저의 실습 환경</h2>
          </div>
          <span className={`overall-status ${capabilities.postgresqlAvailable ? "ready" : "limited"}`}>
            {capabilities.postgresqlAvailable ? "모든 모드 사용 가능" : "제한된 환경"}
          </span>
        </div>

        <div className="mode-grid">
          <article className={`mode-card ${selectedMode === "sqlite" ? "selected" : ""}`}>
            <div className="mode-title-row">
              <span className="database-icon sqlite" aria-hidden="true" />
              <div>
                <p className="mode-kicker">Local Python DB</p>
                <h3>SQLite</h3>
              </div>
              <span className={`status-dot ${capabilities.sqliteAvailable ? "ready" : "blocked"}`}>
                {capabilities.sqliteAvailable ? "준비됨" : "지원 안 됨"}
              </span>
            </div>
            <p>Pyodide 안에서 Alembic과 SQLAlchemy가 SQLite 파일에 직접 연결합니다.</p>
            <button
              type="button"
              disabled={!capabilities.sqliteAvailable}
              aria-pressed={selectedMode === "sqlite"}
              onClick={() => setSelectedMode("sqlite")}
            >
              SQLite 환경 선택
            </button>
          </article>

          <article className={`mode-card ${selectedMode === "postgresql" ? "selected" : ""}`}>
            <div className="mode-title-row">
              <span className="database-icon postgres" aria-hidden="true" />
              <div>
                <p className="mode-kicker">PostgreSQL WASM</p>
                <h3>PostgreSQL</h3>
              </div>
              <span className={`status-dot ${capabilities.postgresqlAvailable ? "ready" : "blocked"}`}>
                {capabilities.postgresqlAvailable ? "준비됨" : "비활성화"}
              </span>
            </div>
            <p>PGlite와 동기 Worker RPC를 위한 브라우저 격리 환경을 사용합니다.</p>
            <button
              type="button"
              disabled={!capabilities.postgresqlAvailable}
              aria-pressed={selectedMode === "postgresql"}
              aria-describedby={!capabilities.postgresqlAvailable ? "postgresql-blockers" : undefined}
              onClick={() => setSelectedMode("postgresql")}
            >
              PostgreSQL 환경 선택
            </button>
            {!capabilities.postgresqlAvailable && (
              <p className="blocker-copy" id="postgresql-blockers" role="status">
                필요한 기능: {capabilities.postgresqlBlockers.join(", ")}. COOP/COEP 헤더를 제공하는
                환경에서 다시 접속하세요.
              </p>
            )}
          </article>
        </div>

        <p className="selection-note" role="status">
          선택된 환경: <strong>{selectedMode === "sqlite" ? "SQLite" : "PostgreSQL"}</strong>
          <span>실제 migration runtime 연결은 후속 태스크에서 활성화됩니다.</span>
        </p>

        <ul className="diagnostic-list" aria-label="브라우저 기능 진단 결과">
          {capabilities.checks.map((check) => (
            <li key={check.key}>
              <span className={`check-indicator ${check.supported ? "ready" : "blocked"}`} aria-hidden="true">
                {check.supported ? "✓" : "×"}
              </span>
              <div>
                <strong>{check.label}</strong>
                <p>{check.description}</p>
              </div>
            </li>
          ))}
        </ul>
      </section>

      <footer>
        <span>Revision Lab</span>
        <span>Everything runs locally in your browser.</span>
      </footer>
    </main>
  );
}
