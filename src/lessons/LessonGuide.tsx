import { assessLesson, canCloneCollaborationBase, lessons, type CollaborationContext, type LessonId } from "./lessons";
import type { Collaboration, Lab, Workspace } from "../lab/store";

const suggestedCommands: Partial<Record<LessonId, string[]>> = {
  init: ["alembic init migrations"],
  "manual-revision": ['alembic revision -m "create users"'],
  "upgrade-downgrade": ["alembic upgrade head", "alembic downgrade -1"],
  autogenerate: ['alembic revision --autogenerate -m "add users"', "alembic upgrade head"],
  collaboration: ['alembic revision -m "Alice change"', 'alembic revision -m "Bob change"', "alembic upgrade head"],
};

function collaborationContext(workspaces: Workspace[], collaboration?: Collaboration): CollaborationContext | undefined {
  if (!collaboration) return undefined;
  const find = (id: string) => {
    const workspace = workspaces.find((item) => item.id === id);
    return workspace ? { snapshot: workspace.snapshot, evidence: workspace.evidence } : undefined;
  };
  return {
    baseRevisions: collaboration.baseRevisions,
    filesIntegrated: collaboration.filesIntegrated,
    multipleHeadsObserved: collaboration.multipleHeadsObserved,
    alice: find(collaboration.aliceId),
    bob: find(collaboration.bobId),
    integration: find(collaboration.integrationId),
  };
}

export function LessonGuide({
  lab, workspace, workspaces, collaboration, activeLesson, enabled, busy, dirty, onCommand,
}: {
  lab: Lab; workspace?: Workspace; workspaces: Workspace[]; collaboration?: Collaboration; activeLesson: LessonId;
  enabled: boolean; busy: boolean; dirty: boolean; onCommand: (command: string) => void;
}) {
  if (!enabled) {
    return <section className="guide-collapsed" aria-label="학습 가이드">
      <div><strong>가이드 모드</strong><span>실제 runtime 상태로 단계 완료를 판정합니다.</span></div>
      <button onClick={() => lab.guide(true)}>학습 가이드 열기</button>
    </section>;
  }
  const lesson = lessons.find((item) => item.id === activeLesson) ?? lessons[0]!;
  const context = collaborationContext(workspaces, collaboration);
  const assessment = assessLesson(activeLesson, workspace && { snapshot: workspace.snapshot, evidence: workspace.evidence }, context);
  const integration = collaboration ? workspaces.find((item) => item.id === collaboration.integrationId) : undefined;
  const heads = integration?.snapshot?.revisions.filter((revision) => revision.isHead).map((revision) => revision.revision) ?? [];
  const mergeCommand = heads.length > 1 ? `alembic merge ${heads.join(" ")} -m "merge Alice and Bob"` : undefined;
  const actorsReady = Boolean(context?.alice?.snapshot?.revisions.some((revision) => !collaboration?.baseRevisions.includes(revision.revision)) &&
    context?.bob?.snapshot?.revisions.some((revision) => !collaboration?.baseRevisions.includes(revision.revision)));
  return <section className="lesson-guide" aria-label="학습 가이드">
    <div className="lesson-nav" role="tablist" aria-label="Alembic lesson">
      {lessons.map((item) => {
        const progress = assessLesson(item.id, workspace && { snapshot: workspace.snapshot, evidence: workspace.evidence }, context);
        return <button key={item.id} role="tab" aria-selected={item.id === activeLesson} onClick={() => lab.lesson(item.id)}>
          <span>{progress.complete ? "✓" : item.number}</span>{item.title}
        </button>;
      })}
      <button className="free-mode" onClick={() => lab.guide(false)}>자유 실습으로 닫기</button>
    </div>
    <div className="lesson-content">
      <div className="lesson-copy"><div className="lesson-title"><span>{lesson.number}</span><div><h2>{lesson.title}</h2><p>{lesson.concept}</p></div></div>
        <ol>{lesson.instructions.map((instruction) => <li key={instruction}>{instruction}</li>)}</ol>
        {lesson.example && <details className="lesson-example" open>
          <summary>{lesson.example.title}</summary>
          <p>{lesson.example.description}</p>
          <div className="example-path"><code>{lesson.example.path}</code>의 전체 내용을 아래 코드로 교체하세요.</div>
          <pre aria-label={`${lesson.example.path} 예제 코드`}><code>{lesson.example.code}</code></pre>
        </details>}
        <div className="command-suggestions">{suggestedCommands[activeLesson]?.map((command) => <button key={command} onClick={() => onCommand(command)}><code>{command}</code></button>)}</div>
      </div>
      <div className="lesson-checks"><div className="check-heading"><strong>실제 상태 검사</strong><span className={assessment.complete ? "complete" : ""}>{assessment.steps.filter((step) => step.complete).length} / {assessment.steps.length}</span></div>
        <ul>{assessment.steps.map((step) => <li key={step.id} className={step.complete ? "complete" : ""}><span aria-hidden="true">{step.complete ? "✓" : "○"}</span>{step.label}</li>)}</ul>
      </div>
    </div>
    {activeLesson === "collaboration" && <div className="collaboration-controls">
      {!collaboration ? <>
        <p>현재 workspace의 파일과 실제 {workspace?.mode === "postgresql" ? "PGlite DB" : "SQLite DB"}를 세 개의 독립 runtime으로 복제합니다.</p>
        <button className="primary" disabled={busy || dirty || workspaces.length !== 1 || !canCloneCollaborationBase(workspace?.snapshot)} onClick={() => void lab.setupCollaboration()}>공통 base에서 협업 환경 만들기</button>
        {workspaces.length !== 1 && <span className="warning">협업 실습은 workspace가 하나일 때 시작할 수 있습니다.</span>}
        {!canCloneCollaborationBase(workspace?.snapshot) && <span className="hint">revision이 하나의 head이고 DB current가 그 head인 상태가 필요합니다.</span>}
      </> : <>
        <div className="actor-switcher" aria-label="협업 workspace">
          {[collaboration.baseId, collaboration.aliceId, collaboration.bobId, collaboration.integrationId].map((id) => {
            const item = workspaces.find((candidate) => candidate.id === id);
            return item && <button key={id} aria-pressed={workspace?.id === id} disabled={busy} onClick={() => lab.select(id)}>{item.name}</button>;
          })}
        </div>
        <button className="primary" disabled={busy || dirty || !actorsReady || collaboration.filesIntegrated} onClick={() => void lab.integrateBranches()}>{collaboration.filesIntegrated ? "PR 파일 합침 완료" : "Alice · Bob PR 파일 합치기"}</button>
        {mergeCommand && <button onClick={() => { lab.select(collaboration.integrationId); onCommand(mergeCommand); }}><code>{mergeCommand}</code> 입력</button>}
        <span className="hint">각 actor의 명령과 DB는 완전히 독립적이며, PR 합치기는 revision 파일만 integration에 복사합니다.</span>
      </>}
    </div>}
  </section>;
}
