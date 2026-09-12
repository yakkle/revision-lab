import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { useStore } from "zustand";
import { detectRuntimeCapabilities } from "./capabilities/detect-runtime-capabilities";
import type { DatabaseMode } from "./runtime/protocol";
import { createLab, type Lab, type Panel } from "./lab/store";
import { CodeEditor } from "./lab/CodeEditor";
import { RevisionGraph } from "./lab/RevisionGraph";
import { DatabasePanel, DiffPanel, LearningNote, LogsPanel } from "./lab/Panels";
import { LessonGuide } from "./lessons/LessonGuide";

const panels: Array<{ id: Panel; label: string }> = [
  { id: "editor", label: "파일 / 코드" }, { id: "graph", label: "Revision DAG" },
  { id: "database", label: "Schema / Data" }, { id: "diff", label: "Diff" }, { id: "logs", label: "원본 로그" },
];
const examples = ["alembic init migrations", 'alembic revision -m "create users"', 'alembic revision --autogenerate -m "update models"', "alembic upgrade head", "alembic downgrade -1", "alembic heads", "alembic history"];

export default function App({ controller }: { controller?: Lab }) {
  const [lab] = useState(() => controller ?? createLab());
  const state = useStore(lab.store);
  const capabilities = useMemo(() => detectRuntimeCapabilities(), []);
  const [mode, setMode] = useState<DatabaseMode>("sqlite");
  const [command, setCommand] = useState("alembic init migrations");
  const [historyOffset, setHistoryOffset] = useState(0);
  const resetDialog = useRef<HTMLDialogElement>(null);
  const workspace = state.workspaces.find((item) => item.id === state.activeId);
  const draft = workspace?.file ? workspace.drafts[workspace.file] : undefined;
  const dirty = Object.values(workspace?.drafts ?? {}).some((item) => item.text !== item.saved);
  const unavailable = mode === "sqlite" ? !capabilities.sqliteAvailable : !capabilities.postgresqlAvailable;
  const disabled = state.busy || !workspace?.snapshot || Boolean(workspace.broken);
  useEffect(() => () => lab.dispose(), [lab]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (lab.store.getState().workspaces.length) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [lab]);
  const tabKey = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    let next: number;
    if (event.key === "ArrowRight") next = (index + 1) % panels.length;
    else if (event.key === "ArrowLeft") next = (index + panels.length - 1) % panels.length;
    else if (event.key === "Home") next = 0;
    else if (event.key === "End") next = panels.length - 1;
    else return;
    event.preventDefault();
    lab.panel(panels[next].id);
    document.getElementById("tab-" + panels[next].id)?.focus();
  };
  return <main onKeyDown={(event) => {
    if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (!disabled) void lab.save(); }
  }}>
    <header className="site-header"><a className="brand" href="./"><span className="brand-mark">RL</span>Revision Lab</a><span className="stage-label">ALEMBIC / LOCAL LAB</span></header>
    <section className="workspace-bar" aria-label="실습 환경 선택">
      <div><h1>Migration 실습실</h1><p>파일, revision, 실제 DB의 변화를 함께 확인하세요.</p></div>
      <div className="workspace-controls">
        <div className="mode-picker"><button disabled={state.busy || !capabilities.sqliteAvailable} aria-pressed={mode === "sqlite"} onClick={() => setMode("sqlite")}>SQLite 환경 선택</button>
          <button disabled={state.busy || !capabilities.postgresqlAvailable} aria-pressed={mode === "postgresql"} onClick={() => setMode("postgresql")}>PostgreSQL 환경 선택</button></div>
        <button className="primary" disabled={state.busy || unavailable || state.workspaces.length >= 4} onClick={() => void lab.create(mode)}>새 workspace 만들기</button>
        {state.workspaces.length > 0 && <label>Workspace <select aria-label="Workspace" value={state.activeId} disabled={state.busy} onChange={(event) => lab.select(event.target.value)}>{state.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}{item.broken ? " · 중단됨" : ""}</option>)}</select></label>}
        {workspace && <button disabled={state.busy} onClick={() => resetDialog.current?.showModal()}>Workspace 초기화</button>}
      </div>
    </section>
    <div className="runtime-bar"><span role="status">{state.busy ? "실행 중 · " + state.progress : workspace?.broken ? "실행기 중단" : workspace?.snapshot ? workspace.name + " 준비됨" : state.progress}</span>{state.busy && <progress aria-label="런타임 진행" />}<span>선택된 환경: <strong>{mode === "sqlite" ? "SQLite" : "PostgreSQL"}</strong></span></div>
    {!capabilities.postgresqlAvailable && <p className="warning">필요한 기능: {capabilities.postgresqlBlockers.join(", ")}. COOP/COEP 헤더를 제공하는 환경에서 다시 접속하세요.</p>}
    <p className="session-note">현재 실습은 이 탭에서만 유지됩니다. 새로고침하면 파일과 DB가 사라집니다. 최대 4개 workspace · Python 코드는 브라우저 Worker에서 실제 실행됩니다.</p>
    <LessonGuide lab={lab} workspace={workspace} workspaces={state.workspaces} collaboration={state.collaboration}
      activeLesson={state.activeLesson} enabled={state.guideEnabled} busy={state.busy} dirty={dirty} onCommand={setCommand} />
    {workspace?.error && <section className="error-box" role="alert"><strong>{workspace.error.code}</strong><p>{workspace.error.message}</p>
      {workspace.stale && <p>표시된 snapshot은 마지막으로 확인한 상태입니다. 최신 DB 상태를 확인하지 못했습니다.</p>}
      {workspace.error.traceback && <details><summary>원본 traceback</summary><pre>{workspace.error.traceback}</pre></details>}
      {workspace.broken && <><p>저장된 체크포인트가 없어 자동 복원할 수 없습니다. 기존 화면의 코드와 로그를 확인한 뒤 별도 workspace에서 다시 시작하세요.</p><button disabled={state.busy || state.workspaces.length >= 4} onClick={() => void lab.create(workspace.mode)}>복구: 새 workspace 만들기</button></>}
    </section>}
    <nav className="panel-tabs" role="tablist" aria-label="실습 패널">{panels.map((panel, index) => <button role="tab" id={"tab-" + panel.id} aria-controls={"panel-" + panel.id} aria-selected={state.panel === panel.id} tabIndex={state.panel === panel.id ? 0 : -1} key={panel.id} onClick={() => lab.panel(panel.id)} onKeyDown={(event) => tabKey(event, index)}>{panel.label}</button>)}</nav>
    <div className={"lab-grid showing-" + state.panel}>
      <section className="panel editor-panel" id="panel-editor" aria-label="파일 / 코드">
        <div className="panel-heading"><h2>01 / Files</h2><button disabled={disabled || !draft || draft.text === draft.saved} onClick={() => void lab.save()}>파일 저장</button></div>
        <div className="editor-layout"><nav className="file-tree" aria-label="Workspace 파일">
          {!workspace?.snapshot?.files.length && <p className="empty">init 후 파일이 표시됩니다.</p>}
          {workspace?.snapshot?.files.map((path) => <button key={path} disabled={disabled} aria-current={workspace.file === path ? "true" : undefined} onClick={() => void lab.openFile(path)} title={path}>
            <span>{path}</span>{workspace.drafts[path]?.text !== workspace.drafts[path]?.saved && <span className="badge">수정</span>}
          </button>)}
        </nav><div className="editor-document"><div className="file-caption">{workspace?.file ?? "파일 선택"}{draft && draft.text !== draft.saved && <span className="badge">저장 안 됨</span>}</div>
          {workspace?.file && draft ? <CodeEditor key={workspace.id + ":" + workspace.file} path={workspace.file} value={draft.text} disabled={disabled} onChange={lab.edit} /> : <div className="empty editor-empty"><strong>첫 migration을 만들어 보세요.</strong><p>아래 터미널에서 <code>alembic init migrations</code>를 실행하면 실제 프로젝트 파일이 생성됩니다.</p></div>}
          <p className="editor-help">Ctrl/⌘ + S 저장 · Tab으로 편집기 밖으로 이동</p>
        </div></div>
      </section>
      <section className={"panel inspector-panel " + (state.panel === "editor" ? "default-graph" : "")} aria-label="실행 결과">
        <div className="panel-heading"><h2>02 / {panels.find((panel) => panel.id === (state.panel === "editor" ? "graph" : state.panel))?.label}</h2><span className="badge">{workspace?.snapshot?.schema.dialect ?? "DB 미연결"}</span></div>
        <div className="panel-body">
          <div id="panel-graph" hidden={state.panel !== "editor" && state.panel !== "graph"}>{workspace?.snapshot ? <RevisionGraph revisions={workspace.snapshot.revisions} selected={workspace.revision} onSelect={(id) => { if (!disabled) void lab.selectRevision(id); }} /> : <p className="empty">Workspace를 생성하면 실제 revision graph를 확인할 수 있습니다.</p>}</div>
          <div id="panel-database" hidden={state.panel !== "database"}>{workspace && <DatabasePanel workspace={workspace} lab={lab} disabled={disabled} />}</div>
          <div id="panel-diff" hidden={state.panel !== "diff"}>{workspace && <DiffPanel workspace={workspace} lab={lab} disabled={disabled} />}</div>
          <div id="panel-logs" hidden={state.panel !== "logs"}>{workspace && <LogsPanel workspace={workspace} />}</div>
        </div>
      </section>
    </div>
    <section className="terminal panel" aria-label="Alembic 터미널">
      <div className="panel-heading"><h2>03 / Alembic terminal</h2><button onClick={() => lab.panel("logs")}>전체 원본 로그</button></div>
      <div className="terminal-output" aria-live="polite">{workspace?.entries.slice(-3).map((entry) => <div key={entry.id}><code>$ {entry.command}</code><span className={entry.result?.success ? "success-text" : "error-text"}>{entry.result?.success ? "성공" : "실패"}</span><pre>{entry.result?.stdout || entry.result?.stderr || entry.result?.error?.message || entry.error?.message || "(출력 없음)"}</pre></div>)}</div>
      {dirty && <p className="warning">저장하지 않은 편집이 있습니다. 파일을 저장한 뒤 명령을 실행하세요.</p>}
      <form onSubmit={(event) => { event.preventDefault(); if (!disabled && !dirty && command.trim()) { setHistoryOffset(0); void lab.run(command); } }}>
        <label htmlFor="command">$</label><input id="command" aria-label="Alembic 명령" value={command} spellCheck={false} maxLength={8192} onChange={(event) => setCommand(event.target.value)} onKeyDown={(event) => {
          if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
          const entries = workspace?.entries ?? [];
          const next = Math.max(0, Math.min(entries.length, historyOffset + (event.key === "ArrowUp" ? 1 : -1)));
          event.preventDefault(); setHistoryOffset(next); setCommand(next ? entries[entries.length - next].command : "");
        }} /><button className="primary" type="submit" disabled={disabled || dirty || !command.trim()}>명령 실행</button>
      </form>
      <details><summary>명령 예시와 사용 안내</summary><p className="hint">예시를 선택해 입력한 뒤 실행하세요. Alembic 명령만 허용하며 pipe, redirection, 외부 shell은 지원하지 않습니다.</p><div className="command-examples">{examples.map((example) => <button key={example} onClick={() => setCommand(example)}><code>{example}</code></button>)}</div></details>
    </section>
    <LearningNote workspace={workspace} />
    <dialog ref={resetDialog} className="reset-dialog" aria-labelledby="reset-title" aria-describedby="reset-description">
      <h2 id="reset-title">Workspace를 초기화할까요?</h2>
      <p id="reset-description">{state.collaboration && workspace?.collaborationId === state.collaboration.id ? "협업 실습의 공통 Base, Alice, Bob, Integration" : workspace?.name}의 파일과 DB를 삭제하고 처음부터 시작합니다. 저장하지 않은 편집도 사라지며 복구할 수 없습니다.</p>
      <div><button autoFocus onClick={() => resetDialog.current?.close()}>취소</button><button className="primary" onClick={() => { resetDialog.current?.close(); void lab.reset(); }}>파일·DB 삭제 후 초기화</button></div>
    </dialog>
    <details className="capabilities"><summary>이 브라우저의 실습 환경</summary><h2>이 브라우저의 실습 환경</h2><ul>{capabilities.checks.map((check) => <li key={check.key}>{check.supported ? "✓" : "×"} {check.label} — {check.description}</li>)}</ul></details>
  </main>;
}
