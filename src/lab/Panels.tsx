import type { TaggedValue } from "../runtime/protocol";
import type { Lab, Workspace } from "./store";

function displayValue(value: TaggedValue): string {
  if (value.tag === "null") return "NULL";
  if (value.tag === "array") return `[${value.value.map(displayValue).join(", ")}]`;
  if (value.tag === "bytea") return `base64:${value.value}`;
  return String(value.value);
}

export function DatabasePanel({ workspace, lab, disabled }: { workspace: Workspace; lab: Lab; disabled: boolean }) {
  const schema = workspace.snapshot?.schema;
  const selected = schema?.tables.find((table) => table.name === workspace.table);
  return <>
    <p className="hint">실제 {schema?.dialect} Inspector 결과 · 테이블을 선택하면 최대 50개 행을 읽습니다.</p>
    <div className="version-strip"><strong>alembic_version</strong>
      <span data-testid="db-version">{schema?.alembicVersion.join(", ") || "base · 적용된 revision 없음"}</span>
      {schema?.alembicVersion.map((revision) => <button key={revision} disabled={disabled} onClick={() => void lab.selectRevision(revision)}>{revision} 파일 열기</button>)}
    </div>
    <div className="object-buttons" aria-label="DB 테이블">
      {schema?.tables.map((table) => <button key={table.name} disabled={disabled} aria-pressed={table.name === workspace.table} onClick={() => void lab.table(table.name)}>{table.name}</button>)}
    </div>
    {!schema?.tables.length && <p className="empty">아직 사용자 테이블이 없습니다. migration을 작성한 뒤 upgrade해 보세요.</p>}
    {selected && <>
      <h3>{selected.name}</h3>
      <div className="table-scroll"><table><caption>컬럼 · {schema?.dialect} 원본 타입</caption><thead><tr><th>이름</th><th>타입</th><th>NULL</th><th>기본값</th></tr></thead>
        <tbody>{selected.columns.map((column) => <tr key={column.name}><td>{column.name}{column.primaryKeyPosition > 0 && <span className="badge">PK</span>}</td><td>{column.type}</td><td>{column.nullable ? "허용" : "금지"}</td><td>{column.default ?? "—"}</td></tr>)}</tbody></table></div>
      <details><summary>PK · FK · Unique · Check · Index</summary><pre>{JSON.stringify({ primaryKey: selected.primaryKey, foreignKeys: selected.foreignKeys, uniqueConstraints: selected.uniqueConstraints, checkConstraints: selected.checkConstraints, indexes: selected.indexes }, null, 2)}</pre></details>
      {selected.foreignKeys.map((key, index) => <button key={index} disabled={disabled} onClick={() => void lab.table(key.referredTable)}>FK → {key.referredTable}</button>)}
    </>}
    {workspace.data && <div className="table-scroll"><table><caption>{workspace.data.table} 실제 데이터{workspace.data.truncated ? " · 처음 50행 (추가 행 있음)" : ` · ${workspace.data.rows.length}행`}</caption>
      <thead><tr>{workspace.data.columns.map((column) => <th key={column}>{column}</th>)}</tr></thead>
      <tbody>{workspace.data.rows.map((row, index) => <tr key={index}>{row.map((cell, column) => <td key={column} title={cell.tag}>{displayValue(cell)}</td>)}</tr>)}</tbody>
    </table>{!workspace.data.rows.length && <p className="hint">저장된 행이 없습니다.</p>}</div>}
  </>;
}

export function DiffPanel({ workspace, lab, disabled }: { workspace: Workspace; lab: Lab; disabled: boolean }) {
  const result = workspace.result;
  return <>
    <h3>마지막 파일 변경</h3>
    {!workspace.changes.length && <p className="hint">파일 변경 없음</p>}
    <ul className="change-list">{workspace.changes.map((change) => <li key={change.path}><span className={`badge ${change.change}`}>{change.change}</span>
      <button disabled={disabled || change.change === "deleted"} onClick={() => void lab.openFile(change.path)}>{change.path}</button></li>)}</ul>
    <h3>마지막 명령의 DB 변화</h3>
    {!result && <p className="empty">명령을 실행하면 전후 실제 snapshot을 비교합니다.</p>}
    {result && <>
      <p><code>{result.argv.join(" ")}</code> · {result.success ? "성공" : "실패 후 실제 상태"}</p>
      <p className="version-strip">alembic_version: {result.schemaDiff.alembicVersion.before.join(", ") || "base"} → {result.schemaDiff.alembicVersion.after.join(", ") || "base"}</p>
      {!result.schemaDiff.changes.length && <p className="hint">Schema 변경 없음. 명령 성공과 schema 변경은 서로 다릅니다.</p>}
      {result.schemaDiff.changes.map((change, index) => <details key={index} open><summary><span className={`badge ${change.change}`}>{change.change}</span> {change.kind} · {change.table}.{change.name}</summary>
        <button disabled={disabled || !workspace.snapshot?.schema.tables.some((table) => table.name === change.table)} onClick={() => void lab.table(change.table)}>DB 테이블 열기</button>
        <div className="diff-columns"><div><strong>Before</strong><pre>{JSON.stringify(change.before ?? null, null, 2)}</pre></div><div><strong>After</strong><pre>{JSON.stringify(change.after ?? null, null, 2)}</pre></div></div>
      </details>)}
    </>}
  </>;
}

export function LogsPanel({ workspace }: { workspace: Workspace }) {
  return <>
    <p className="hint">런타임이 반환한 stdout, stderr, traceback 원문입니다. 최근 100개 명령을 보관합니다.</p>
    {workspace.entries.length === 0 && <p className="empty">명령 실행 기록이 없습니다.</p>}
    {[...workspace.entries].reverse().map((entry) => <article className="log-entry" key={entry.id}>
      <h3><code>$ {entry.command}</code> <span className="badge">{entry.result?.success ? "성공" : "실패"}</span></h3>
      <h4>stdout</h4><pre>{entry.result?.stdout || "(empty)"}</pre>
      <h4>stderr</h4><pre>{entry.result?.stderr || "(empty)"}</pre>
      {(entry.error || entry.result?.error) && <pre className="error-text">{JSON.stringify(entry.error ?? entry.result?.error, null, 2)}</pre>}
      {entry.result?.traceback && <><h4>traceback</h4><pre className="error-text">{entry.result.traceback}</pre></>}
    </article>)}
  </>;
}

export function LearningNote({ workspace }: { workspace?: Workspace }) {
  const result = workspace?.result;
  let text = "먼저 alembic init migrations를 실행하세요. 생성된 models.py와 migration 파일을 직접 편집할 수 있습니다.";
  if (workspace?.broken) text = "실행기가 중단되어 마지막으로 확인한 상태를 표시합니다. 현재 버전은 체크포인트 복원을 지원하지 않습니다. 새 workspace에서 다시 시작할 수 있습니다.";
  else if (result?.error) text = "명령이 실패했습니다. 원본 오류를 확인하고 실제 DB와 diff를 비교하세요. 실패했다고 모든 변경이 되돌아갔다고 가정하지 마세요.";
  else if (result?.argv.includes("--autogenerate")) text = "Autogenerate는 migration 후보만 만듭니다. 생성된 파일을 검토한 뒤 upgrade하세요. rename이나 데이터 변환은 직접 수정해야 할 수 있습니다.";
  else if (workspace?.snapshot && workspace.snapshot.revisions.filter((node) => node.isHead).length > 1) text = "서로 다른 revision ID라도 여러 head가 생길 수 있습니다. alembic heads로 확인한 뒤 alembic merge <head1> <head2>로 연결하세요. DDL 충돌은 별도로 해결해야 합니다.";
  else if (result) text = "Revision 파일을 만드는 것과 DB에 적용하는 것은 다릅니다. graph의 head와 DB current를 비교하세요. upgrade 또는 downgrade 후 실제 schema와 version 행을 확인하세요.";
  return <aside className="learning-note" aria-label="학습 설명"><strong>학습 설명</strong><p>{text}</p></aside>;
}
