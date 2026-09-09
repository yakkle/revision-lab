import { useMemo } from "react";
import { Background, Controls, ReactFlow, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import type { RevisionNode } from "../runtime/protocol";

function graphLayout(revisions: RevisionNode[], selected?: string): { nodes: Node[]; edges: Edge[] } {
  const depths = new Map<string, number>();
  const depth = (id: string, seen = new Set<string>()): number => {
    if (depths.has(id)) return depths.get(id)!;
    if (seen.has(id)) return 1;
    const revision = revisions.find((item) => item.revision === id);
    const value = 1 + Math.max(0, ...(revision?.downRevisions ?? []).map((parent) => depth(parent, new Set([...seen, id]))));
    depths.set(id, value);
    return value;
  };
  const lanes = new Map<number, number>();
  const nodes: Node[] = [{ id: "__base", position: { x: 0, y: 0 }, data: { label: "base" }, sourcePosition: Position.Bottom, selectable: false }];
  const edges: Edge[] = [];
  for (const revision of [...revisions].reverse()) {
    const row = depth(revision.revision);
    const lane = lanes.get(row) ?? 0;
    lanes.set(row, lane + 1);
    const markers = [revision.isHead && "head", revision.isCurrent && "DB current", revision.isBranchPoint && "branch", revision.isMergePoint && "merge"].filter(Boolean).join(" · ");
    nodes.push({ id: revision.revision, position: { x: lane * 240, y: row * 100 },
      data: { label: `${revision.revision}\n${markers}` }, selected: revision.revision === selected,
      sourcePosition: Position.Bottom, targetPosition: Position.Top,
      className: revision.isCurrent ? "db-current-node" : undefined, ariaLabel: `revision ${revision.revision} ${markers}` });
    for (const parent of revision.downRevisions.length ? revision.downRevisions : ["__base"]) {
      edges.push({ id: `${parent}-${revision.revision}`, source: parent, target: revision.revision, type: "smoothstep" });
    }
    for (const parent of revision.dependsOn) edges.push({ id: `dependency-${parent}-${revision.revision}`, source: parent, target: revision.revision, label: "depends_on", style: { strokeDasharray: "5 5" } });
  }
  return { nodes, edges };
}

export function RevisionGraph({ revisions, selected, onSelect }: { revisions: RevisionNode[]; selected?: string; onSelect: (id: string) => void }) {
  const { nodes, edges } = useMemo(() => graphLayout(revisions, selected), [revisions, selected]);
  return <>
    <p className="hint">head는 파일의 끝점, DB current는 실제 적용 위치입니다. 노드를 선택하면 파일이 열립니다.</p>
    <div className="revision-canvas">
      <ReactFlow key={revisions.map((node) => node.revision).join(",")} nodes={nodes} edges={edges} fitView colorMode="dark"
        nodesDraggable={false} nodesConnectable={false} edgesFocusable={false}
        onNodeClick={(_, node) => { if (node.id !== "__base") onSelect(node.id); }}>
        <Background /><Controls showInteractive={false} />
      </ReactFlow>
    </div>
    <ul className="revision-list" aria-label="Revision 목록">
      {revisions.map((node) => <li key={node.revision}><button type="button" aria-pressed={selected === node.revision} onClick={() => onSelect(node.revision)}>
        {node.revision} {node.isHead && <span className="badge">head</span>} {node.isCurrent && <span className="badge current">DB current</span>}
        {node.isBranchPoint && " · branch"}{node.isMergePoint && " · merge"}
      </button><small>부모: {node.downRevisions.join(", ") || "base"}{node.branchLabels.length > 0 && ` · label: ${node.branchLabels.join(", ")}`}</small></li>)}
    </ul>
  </>;
}
