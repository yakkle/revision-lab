import {
  useEffect, useMemo, useRef, useState,
  type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent,
} from "react";
import { useStore } from "zustand";
import { detectRuntimeCapabilities } from "./capabilities/detect-runtime-capabilities";
import type { DatabaseMode } from "./runtime/protocol";
import {
  createLab, MAX_TERMINAL_DOCK_HEIGHT, MIN_TERMINAL_DOCK_HEIGHT,
  type Lab, type Panel,
} from "./lab/store";
import { CodeEditor } from "./lab/CodeEditor";
import { RevisionGraph } from "./lab/RevisionGraph";
import { DatabasePanel, DiffPanel, LearningNote, LogsPanel } from "./lab/Panels";
import { LessonGuide } from "./lessons/LessonGuide";
import { archiveHasExecutablePython, readWorkspaceArchive, type WorkspaceArchiveV1 } from "./persistence/workspace-archive";

declare global {
  interface Window { __revisionLabT8?: { crashActive: () => void } }
}

const panels: Array<{ id: Panel; label: string }> = [
  { id: "editor", label: "파일 / 코드" }, { id: "graph", label: "Revision DAG" },
  { id: "database", label: "Schema / Data" }, { id: "diff", label: "Diff" }, { id: "logs", label: "원본 로그" },
];
const examples = ["alembic init migrations", 'alembic revision -m "create users"', 'alembic revision --autogenerate -m "add email"', "alembic upgrade head", "alembic downgrade -1", "alembic heads", "alembic history"];

export default function App({ controller }: { controller?: Lab }) {
  const [lab] = useState(() => controller ?? createLab());
  const state = useStore(lab.store);
  const capabilities = useMemo(() => detectRuntimeCapabilities(), []);
  const [command, setCommand] = useState("alembic init migrations");
  const [historyOffset, setHistoryOffset] = useState(0);
  const [editorMaximized, setEditorMaximized] = useState(false);
  const [commandNotice, setCommandNotice] = useState("명령을 입력하고 실행하세요.");
  const [pendingArchive, setPendingArchive] = useState<{ name: string; archive: WorkspaceArchiveV1 }>();
  const [previewPath, setPreviewPath] = useState<string>();
  const [pythonReviewed, setPythonReviewed] = useState(false);
  const [archiveError, setArchiveError] = useState<string>();
  const [openPopover, setOpenPopover] = useState<"workspace" | "commands">();
  const [pendingDeletion, setPendingDeletion] = useState<{ path: string; revision: string }>();
  const resetDialog = useRef<HTMLDialogElement>(null);
  const importDialog = useRef<HTMLDialogElement>(null);
  const deleteDialog = useRef<HTMLDialogElement>(null);
  const importInput = useRef<HTMLInputElement>(null);
  const workspaceMenu = useRef<HTMLDivElement>(null);
  const workspaceMenuButton = useRef<HTMLButtonElement>(null);
  const commandMenu = useRef<HTMLDivElement>(null);
  const commandMenuButton = useRef<HTMLButtonElement>(null);
  const commandInput = useRef<HTMLInputElement>(null);
  const terminalOutput = useRef<HTMLDivElement>(null);
  const maximizeButton = useRef<HTMLButtonElement>(null);
  const workspace = state.workspaces.find((item) => item.id === state.activeId);
  const draft = workspace?.file ? workspace.drafts[workspace.file] : undefined;
  const dirty = Object.values(workspace?.drafts ?? {}).some((item) => item.text !== item.saved);
  const atWorkspaceLimit = state.workspaces.length >= 4;
  const disabled = state.busy || state.restoring || !workspace?.snapshot || Boolean(workspace.broken);
  const latestEntry = workspace?.entries.at(-1);
  const selectedRevision = workspace?.snapshot?.revisions.find((revision) => revision.path === workspace.file);
  const deletionBlockedReason = !selectedRevision ? undefined
    : !selectedRevision.isHead ? "자식 revision이 있어 삭제할 수 없습니다."
      : selectedRevision.isCurrent || workspace?.snapshot?.schema.alembicVersion.includes(selectedRevision.revision)
        ? "DB에 적용된 revision입니다. 먼저 downgrade하세요." : undefined;

  useEffect(() => {
    void lab.restore();
    if (import.meta.env.VITE_T8_TEST_HOOK === "1") window.__revisionLabT8 = { crashActive: lab.forceCrashForTest };
    return () => { delete window.__revisionLabT8; lab.dispose(); };
  }, [lab]);
  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      const current = lab.store.getState();
      const hasDraft = current.workspaces.some((item) => Object.values(item.drafts).some((itemDraft) => itemDraft.text !== itemDraft.saved));
      if (current.busy || hasDraft) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", beforeUnload);
    return () => window.removeEventListener("beforeunload", beforeUnload);
  }, [lab]);
  useEffect(() => {
    const dialog = importDialog.current;
    if (pendingArchive && dialog && !dialog.open) dialog.showModal();
  }, [pendingArchive]);
  useEffect(() => {
    const dialog = deleteDialog.current;
    if (pendingDeletion && dialog && !dialog.open) dialog.showModal();
  }, [pendingDeletion]);
  useEffect(() => {
    if (!openPopover) return;
    const outside = (event: globalThis.PointerEvent) => {
      const container = openPopover === "workspace" ? workspaceMenu.current : commandMenu.current;
      if (container?.contains(event.target as Node)) return;
      setOpenPopover(undefined);
    };
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      const trigger = openPopover === "workspace" ? workspaceMenuButton.current : commandMenuButton.current;
      setOpenPopover(undefined);
      window.requestAnimationFrame(() => trigger?.focus());
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape, { capture: true });
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape, { capture: true });
    };
  }, [openPopover]);
  useEffect(() => {
    if (!latestEntry || !terminalOutput.current) return;
    terminalOutput.current.scrollTop = terminalOutput.current.scrollHeight;
    setCommandNotice(`${latestEntry.command} 명령이 ${latestEntry.result?.success ? "성공" : "실패"}했습니다.`);
  }, [latestEntry]);
  useEffect(() => {
    if (!editorMaximized) return;
    const escape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopPropagation();
      setEditorMaximized(false);
      window.requestAnimationFrame(() => maximizeButton.current?.focus());
    };
    window.addEventListener("keydown", escape, { capture: true });
    return () => window.removeEventListener("keydown", escape, { capture: true });
  }, [editorMaximized]);

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
  const closeWorkspaceMenu = () => setOpenPopover((current) => current === "workspace" ? undefined : current);
  const createWorkspace = (mode: DatabaseMode) => {
    closeWorkspaceMenu();
    void lab.create(mode);
  };
  const exportWorkspace = async () => {
    closeWorkspaceMenu();
    const exported = await lab.exportArchive();
    if (!exported) return;
    const url = URL.createObjectURL(exported.blob);
    const anchor = document.createElement("a");
    anchor.href = url; anchor.download = exported.filename; anchor.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  };
  const chooseArchive = async (file?: File) => {
    if (!file) return;
    setArchiveError(undefined); setPendingArchive(undefined); setPythonReviewed(false);
    try {
      const archive = await readWorkspaceArchive(file);
      setPendingArchive({ name: file.name, archive });
      setPreviewPath(archive.files[0]?.path);
    } catch (error) {
      setArchiveError(error instanceof Error ? error.message : String(error));
    } finally { if (importInput.current) importInput.current.value = ""; }
  };
  const stageCommand = (source: string) => {
    setOpenPopover(undefined);
    setCommand(source);
    setHistoryOffset(0);
    setCommandNotice("명령을 터미널에 입력했습니다. 내용을 확인한 뒤 실행하세요.");
    commandInput.current?.focus();
    commandInput.current?.select();
    window.requestAnimationFrame(() => {
      const reducedMotion = typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      commandInput.current?.scrollIntoView?.({ block: "nearest", behavior: reducedMotion ? "auto" : "smooth" });
    });
  };
  const startTerminalResize = (event: ReactPointerEvent<HTMLDivElement>) => {
    event.preventDefault();
    const startY = event.clientY;
    const startHeight = state.terminalDockHeight;
    let nextHeight = startHeight;
    const move = (moveEvent: PointerEvent) => {
      nextHeight = startHeight + startY - moveEvent.clientY;
      lab.resizeTerminal(nextHeight);
    };
    const finish = () => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", finish);
      window.removeEventListener("pointercancel", finish);
      lab.resizeTerminal(nextHeight, true);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", finish);
    window.addEventListener("pointercancel", finish);
  };
  const resizeTerminalWithKeyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    let height: number | undefined;
    if (event.key === "ArrowUp") height = state.terminalDockHeight + 16;
    else if (event.key === "ArrowDown") height = state.terminalDockHeight - 16;
    else if (event.key === "Home") height = MIN_TERMINAL_DOCK_HEIGHT;
    else if (event.key === "End") height = MAX_TERMINAL_DOCK_HEIGHT;
    if (height === undefined) return;
    event.preventDefault();
    lab.resizeTerminal(height, true);
  };
  const restoreEditor = () => {
    setEditorMaximized(false);
    window.requestAnimationFrame(() => maximizeButton.current?.focus());
  };

  return <main className={`app-shell ${state.guideEnabled ? "guide-open" : "guide-closed"} ${editorMaximized ? "editor-maximized" : ""}`}
    style={{ "--terminal-height": `${state.terminalDockHeight}px` } as CSSProperties}
    onKeyDown={(event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === "s") { event.preventDefault(); if (!disabled) void lab.save(); }
    }}>
    <header className="app-header">
      <a className="brand" href="./"><span className="brand-mark">RL</span><span><strong>Revision Lab</strong><small>Alembic migration playground</small></span></a>
      <h1 className="visually-hidden">Migration 실습실</h1>
      <div className="workspace-switcher">
        {state.workspaces.length > 0 ? <label><span className="visually-hidden">Workspace</span><select aria-label="Workspace" value={state.activeId} disabled={state.busy} onChange={(event) => lab.select(event.target.value)}>{state.workspaces.map((item) => <option key={item.id} value={item.id}>{item.name}{item.broken ? " · 중단됨" : ""}</option>)}</select></label> : <span className="empty-workspace-label">Workspace 없음</span>}
        <span className={`database-badge ${workspace?.mode ?? ""}`}>{workspace ? workspace.mode === "sqlite" ? "SQLite" : "PostgreSQL" : "DB 미연결"}</span>
      </div>
      <div className="workspace-menu" ref={workspaceMenu}>
        <button ref={workspaceMenuButton} className="popover-trigger" aria-label="Workspace 관리" aria-expanded={openPopover === "workspace"} aria-controls="workspace-menu-panel" onClick={() => setOpenPopover((current) => current === "workspace" ? undefined : "workspace")}>Workspace 관리</button>
        {openPopover === "workspace" && <div className="workspace-menu-panel" id="workspace-menu-panel">
          <strong>새 실습 환경</strong>
          <button disabled={state.busy || state.restoring || !capabilities.sqliteAvailable || atWorkspaceLimit} onClick={() => createWorkspace("sqlite")}>SQLite workspace 만들기</button>
          <button disabled={state.busy || state.restoring || !capabilities.postgresqlAvailable || atWorkspaceLimit} onClick={() => createWorkspace("postgresql")}>PostgreSQL workspace 만들기</button>
          {!capabilities.postgresqlAvailable && <p className="menu-hint">PostgreSQL에 필요한 기능: {capabilities.postgresqlBlockers.join(", ")}. COOP/COEP 환경에서 사용할 수 있습니다.</p>}
          <hr />
          <button disabled={state.busy || !workspace || dirty || workspace.broken} onClick={() => void exportWorkspace()}>Workspace 내보내기</button>
          <button disabled={state.busy || atWorkspaceLimit} onClick={() => { closeWorkspaceMenu(); importInput.current?.click(); }}>Workspace 가져오기</button>
          <details className="environment-details"><summary>이 브라우저의 실습 환경</summary><ul>{capabilities.checks.map((check) => <li key={check.key}>{check.supported ? "✓" : "×"} {check.label} — {check.description}</li>)}</ul></details>
          {workspace && <><hr /><button className="danger-action" disabled={state.busy} onClick={() => { closeWorkspaceMenu(); resetDialog.current?.showModal(); }}>Workspace 초기화</button></>}
        </div>}
        <input ref={importInput} className="visually-hidden" type="file" accept=".zip,application/zip" aria-label="Workspace archive 파일" onChange={(event) => void chooseArchive(event.target.files?.[0])} />
      </div>
    </header>

    <div className="runtime-bar">
      <span role="status">{state.busy ? "실행 중 · " + state.progress : workspace?.broken ? "실행기 중단" : workspace?.snapshot ? workspace.name + " 준비됨" : state.progress}</span>
      {state.busy && <progress aria-label="런타임 진행" />}
      <span>{workspace?.savedAt ? `체크포인트 ${new Date(workspace.savedAt).toLocaleTimeString("ko-KR", { hour: "2-digit", minute: "2-digit" })}` : "브라우저 로컬 저장"}</span>
    </div>

    <div className="notice-stack">
      {workspace?.recoveredAt && <p className="success-banner" role="status">Worker 중단 후 {new Date(workspace.recoveredAt).toLocaleTimeString("ko-KR")}에 마지막 성공 체크포인트로 복원했습니다.</p>}
      {archiveError && <p className="error-box" role="alert"><strong>ARCHIVE_IMPORT_REJECTED</strong><br />{archiveError}</p>}
      {workspace?.error && <section className="error-box" role="alert"><strong>{workspace.error.code}</strong><p>{workspace.error.message}</p>
        {workspace.stale && <p>표시된 snapshot은 마지막으로 확인한 상태입니다. 최신 DB 상태를 확인하지 못했습니다.</p>}
        {workspace.error.traceback && <details><summary>원본 traceback</summary><pre>{workspace.error.traceback}</pre></details>}
        {workspace.broken && <><p>자동 복원이 완료되지 않았습니다. 마지막 성공 체크포인트를 다시 시도하거나 새 workspace를 만드세요.</p><button disabled={state.busy} onClick={() => void lab.recover()}>체크포인트 복원 다시 시도</button> <button disabled={state.busy || atWorkspaceLimit} onClick={() => void lab.create(workspace.mode)}>새 workspace 만들기</button></>}
      </section>}
    </div>

    <div className="workbench">
      <aside className="guide-sidebar" aria-label="학습 가이드 사이드바">
        <LessonGuide lab={lab} workspace={workspace} workspaces={state.workspaces} collaboration={state.collaboration}
          activeLesson={state.activeLesson} enabled={state.guideEnabled} busy={state.busy} dirty={dirty} onStageCommand={stageCommand}
          footer={state.guideEnabled ? <LearningNote workspace={workspace} /> : undefined} />
      </aside>

      <section className="workbench-main" aria-label="Alembic 작업면">
        <nav className="panel-tabs" role="tablist" aria-label="실습 패널">{panels.map((panel, index) => <button role="tab" id={"tab-" + panel.id} aria-controls={"panel-" + panel.id} aria-selected={state.panel === panel.id} tabIndex={state.panel === panel.id ? 0 : -1} key={panel.id} onClick={() => lab.panel(panel.id)} onKeyDown={(event) => tabKey(event, index)}>{panel.label}</button>)}</nav>
        <div className={`lab-grid showing-${state.panel}`}>
          <section className="panel editor-panel" id="panel-editor" aria-label="파일 / 코드">
            <div className="panel-heading"><h2>01 / Files</h2><div className="panel-actions"><button disabled={disabled || !draft || draft.text === draft.saved} onClick={() => void lab.save()}>파일 저장</button>{selectedRevision && <button className="danger-action" title={dirty ? "저장하지 않은 편집을 먼저 저장하세요." : deletionBlockedReason} disabled={disabled || dirty || Boolean(deletionBlockedReason)} onClick={() => setPendingDeletion({ path: selectedRevision.path!, revision: selectedRevision.revision })}>migration 삭제</button>}<button ref={maximizeButton} aria-pressed={editorMaximized} onClick={() => editorMaximized ? restoreEditor() : setEditorMaximized(true)}>{editorMaximized ? "기본 크기로 복원" : "편집기 최대화"}</button></div></div>
            <div className="editor-layout"><nav className="file-tree" aria-label="Workspace 파일">
              {!workspace?.snapshot?.files.length && <p className="empty">init 후 파일이 표시됩니다.</p>}
              {workspace?.snapshot?.files.map((path) => <button key={path} disabled={disabled} aria-current={workspace.file === path ? "true" : undefined} onClick={() => void lab.openFile(path)} title={path}>
                <span>{path}</span>{workspace.drafts[path]?.text !== workspace.drafts[path]?.saved && <span className="badge">수정</span>}
              </button>)}
            </nav><div className="editor-document"><div className="file-caption">{workspace?.file ?? "파일 선택"}{draft && draft.text !== draft.saved && <span className="badge">저장 안 됨</span>}</div>
              {workspace?.file && draft ? <CodeEditor key={workspace.id + ":" + workspace.file} path={workspace.file} value={draft.text} disabled={disabled} onChange={lab.edit} /> : <div className="empty editor-empty"><strong>{workspace ? "첫 migration을 만들어 보세요." : "새 실습을 시작하세요."}</strong><p>{workspace ? <><code>alembic init migrations</code>를 실행하면 실제 프로젝트 파일이 생성됩니다.</> : "브라우저 안에서 실제 Alembic과 DB를 실행합니다."}</p>{!workspace && <div className="start-actions"><button className="primary" disabled={state.busy || !capabilities.sqliteAvailable} onClick={() => createWorkspace("sqlite")}>SQLite workspace 만들기</button><button disabled={state.busy || !capabilities.postgresqlAvailable} onClick={() => createWorkspace("postgresql")}>PostgreSQL workspace 만들기</button>{!capabilities.postgresqlAvailable && <span className="hint">PostgreSQL: {capabilities.postgresqlBlockers.join(", ")} 필요</span>}</div>}</div>}
              <p className="editor-help">Ctrl/⌘ + S 저장 · Tab으로 편집기 밖으로 이동</p>
            </div></div>
          </section>
          <section className={`panel inspector-panel ${state.panel === "editor" ? "default-graph" : ""}`} aria-label="실행 결과">
            <div className="panel-heading"><h2>02 / {panels.find((panel) => panel.id === (state.panel === "editor" ? "graph" : state.panel))?.label}</h2><span className="badge">{workspace?.snapshot?.schema.dialect ?? "DB 미연결"}</span></div>
            <div className="panel-body">
              <div id="panel-graph" hidden={state.panel !== "editor" && state.panel !== "graph"}>{workspace?.snapshot ? <RevisionGraph revisions={workspace.snapshot.revisions} selected={workspace.revision} onSelect={(id) => { if (!disabled) void lab.selectRevision(id); }} /> : <p className="empty">Workspace를 생성하면 실제 revision graph를 확인할 수 있습니다.</p>}</div>
              <div id="panel-database" hidden={state.panel !== "database"}>{workspace && <DatabasePanel workspace={workspace} lab={lab} disabled={disabled} />}</div>
              <div id="panel-diff" hidden={state.panel !== "diff"}>{workspace && <DiffPanel workspace={workspace} lab={lab} disabled={disabled} />}</div>
              <div id="panel-logs" hidden={state.panel !== "logs"}>{workspace && <LogsPanel workspace={workspace} />}</div>
            </div>
          </section>
        </div>

        <div className="terminal-resizer" role="separator" aria-label="터미널 높이 조절" aria-orientation="horizontal"
          aria-valuemin={MIN_TERMINAL_DOCK_HEIGHT} aria-valuemax={MAX_TERMINAL_DOCK_HEIGHT} aria-valuenow={state.terminalDockHeight}
          tabIndex={editorMaximized ? -1 : 0} onPointerDown={startTerminalResize} onKeyDown={resizeTerminalWithKeyboard}><span /></div>
        <section className="terminal panel" aria-label="Alembic 터미널">
          <div className="panel-heading"><h2>03 / Alembic terminal</h2><div className="terminal-actions"><div className="command-menu" ref={commandMenu}><button ref={commandMenuButton} className="popover-trigger" aria-expanded={openPopover === "commands"} aria-controls="terminal-command-examples" onClick={() => setOpenPopover((current) => current === "commands" ? undefined : "commands")}>명령 예시</button>{openPopover === "commands" && <div className="terminal-help" id="terminal-command-examples"><p>예시를 입력한 뒤 실행하세요. pipe, redirection, 외부 shell은 지원하지 않습니다.</p><div className="command-examples">{examples.map((example) => <button key={example} onClick={() => stageCommand(example)}><code>{example}</code></button>)}</div></div>}</div><button onClick={() => lab.panel("logs")}>전체 원본 로그</button></div></div>
          <div className="terminal-output" ref={terminalOutput}>{workspace?.entries.slice(-3).map((entry) => <div key={entry.id}><code>$ {entry.command}</code><span className={entry.result?.success ? "success-text" : "error-text"}>{entry.result?.success ? "성공" : "실패"}</span><pre>{entry.result?.stdout || entry.result?.stderr || entry.result?.error?.message || entry.error?.message || "(출력 없음)"}</pre></div>)}</div>
          <span className="visually-hidden" aria-live="polite">{commandNotice}</span>
          {dirty && <p className="command-warning">저장하지 않은 편집이 있습니다. 저장 후 실행하세요.</p>}
          <form onSubmit={(event) => { event.preventDefault(); if (!disabled && !dirty && command.trim()) { setHistoryOffset(0); setCommandNotice(`${command} 명령을 실행하고 있습니다.`); void lab.run(command); } }}>
            <label htmlFor="command">$</label><input ref={commandInput} id="command" aria-label="Alembic 명령" value={command} spellCheck={false} maxLength={8192} onChange={(event) => { setCommand(event.target.value); setCommandNotice("명령을 수정했습니다."); }} onKeyDown={(event) => {
              if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
              const entries = workspace?.entries ?? [];
              const next = Math.max(0, Math.min(entries.length, historyOffset + (event.key === "ArrowUp" ? 1 : -1)));
              event.preventDefault(); setHistoryOffset(next); setCommand(next ? entries[entries.length - next].command : "");
            }} /><button className="primary" type="submit" disabled={disabled || dirty || !command.trim()}>명령 실행</button>
          </form>
        </section>
      </section>
    </div>

    {pendingArchive && <dialog ref={importDialog} className="import-dialog" aria-labelledby="import-title" aria-describedby="import-description" onCancel={() => { setPendingArchive(undefined); setPreviewPath(undefined); }}>
      <h2 id="import-title">외부 workspace 확인</h2>
      <p id="import-description"><strong>{pendingArchive.name}</strong> · {pendingArchive.archive.workspace.mode === "sqlite" ? "SQLite" : "PostgreSQL"} · 파일 {pendingArchive.archive.files.length}개</p>
      <p className="warning">가져온 migration Python은 브라우저 Worker에서 실제 실행될 수 있습니다. 파일 내용을 확인한 뒤 가져오세요.</p>
      <div className="archive-preview">
        <nav aria-label="가져올 파일 목록">{pendingArchive.archive.files.map((file) => <button key={file.path} aria-current={previewPath === file.path ? "true" : undefined} onClick={() => setPreviewPath(file.path)}>{file.path}</button>)}</nav>
        <pre aria-label="가져올 파일 내용">{pendingArchive.archive.files.find((file) => file.path === previewPath)?.content ?? "파일이 없습니다."}</pre>
      </div>
      {archiveHasExecutablePython(pendingArchive.archive) && <label className="review-confirm"><input type="checkbox" checked={pythonReviewed} onChange={(event) => setPythonReviewed(event.target.checked)} /> Python 파일 목록과 내용을 확인했습니다.</label>}
      <div className="dialog-actions"><button autoFocus onClick={() => { setPendingArchive(undefined); setPreviewPath(undefined); }}>취소</button>
        <button className="primary" disabled={archiveHasExecutablePython(pendingArchive.archive) && !pythonReviewed} onClick={() => {
          const archive = pendingArchive.archive;
          setPendingArchive(undefined); setPreviewPath(undefined); setPythonReviewed(false);
          void lab.importArchive(archive);
        }}>확인 후 가져오기</button></div>
    </dialog>}
    {pendingDeletion && <dialog ref={deleteDialog} className="reset-dialog" aria-labelledby="delete-title" aria-describedby="delete-description" onCancel={() => setPendingDeletion(undefined)}>
      <h2 id="delete-title">Migration 파일 삭제</h2>
      <p id="delete-description"><code>{pendingDeletion.path}</code> · revision <code>{pendingDeletion.revision}</code>을 삭제합니다. 삭제 후 revision graph가 즉시 다시 계산됩니다.</p>
      <div><button autoFocus onClick={() => setPendingDeletion(undefined)}>취소</button><button className="danger-action" onClick={() => { const target = pendingDeletion.path; setPendingDeletion(undefined); void lab.deleteRevision(target); }}>미적용 migration 삭제</button></div>
    </dialog>}
    <dialog ref={resetDialog} className="reset-dialog" aria-labelledby="reset-title" aria-describedby="reset-description">
      <h2 id="reset-title">Workspace를 초기화할까요?</h2>
      <p id="reset-description">{state.collaboration && workspace?.collaborationId === state.collaboration.id ? "협업 실습의 공통 Base, Alice, Bob, Integration" : workspace?.name}의 파일과 DB를 삭제하고 처음부터 시작합니다. 저장하지 않은 편집도 사라지며 복구할 수 없습니다.</p>
      <div><button autoFocus onClick={() => resetDialog.current?.close()}>취소</button><button className="danger-action" onClick={() => { resetDialog.current?.close(); void lab.reset(); }}>파일·DB 삭제 후 초기화</button></div>
    </dialog>
  </main>;
}
