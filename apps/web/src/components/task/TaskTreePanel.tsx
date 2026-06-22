import { useMemo, useState } from "react";
import type { TaskTreeNode } from "../../lib/types";

interface TaskTreePanelProps {
  tree: TaskTreeNode;
  onNodeClick: (id: string) => void;
}

interface FlatNode {
  node: TaskTreeNode;
  depth: number;
  hasChildren: boolean;
}

function flatten(root: TaskTreeNode, expanded: Set<string>, depth = 0, acc: FlatNode[] = []): FlatNode[] {
  const hasChildren = root.children.length > 0;
  acc.push({ node: root, depth, hasChildren });
  if (hasChildren && (expanded.has(root.id) || depth === 0)) {
    for (const child of root.children) {
      flatten(child, expanded, depth + 1, acc);
    }
  }
  return acc;
}

function countNodes(node: TaskTreeNode): number {
  return 1 + node.children.reduce((sum, c) => sum + countNodes(c), 0);
}

function countByType(node: TaskTreeNode, type: TaskTreeNode["type"]): number {
  const self = node.type === type ? 1 : 0;
  return self + node.children.reduce((sum, c) => sum + countByType(c, type), 0);
}

function formatTime(iso: string | undefined): string {
  if (!iso) return "";
  try {
    return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch {
    return "";
  }
}

function kindLabel(type: TaskTreeNode["type"]): string {
  switch (type) {
    case "task": return "root";
    case "leader_response": return "leader";
    case "user_message": return "user";
    case "tool_call": return "";
    case "tool_result": return "";
    case "teammate": return "spawn_teammate";
    default: return type;
  }
}

export function TaskTreePanel({ tree, onNodeClick }: TaskTreePanelProps) {
  // Expand the root and its direct children by default so the user
  // sees structure immediately. Deeper nodes collapse until clicked.
  const initialExpanded = useMemo(() => {
    const s = new Set<string>([tree.id]);
    for (const c of tree.children) s.add(c.id);
    return s;
  }, [tree.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const [expanded, setExpanded] = useState<Set<string>>(initialExpanded);
  const [activeId, setActiveId] = useState<string | null>(null);

  const flat = useMemo(() => flatten(tree, expanded), [tree, expanded]);
  const total = useMemo(() => countNodes(tree), [tree]);
  const toolCalls = useMemo(() => countByType(tree, "tool_call"), [tree]);
  // Mockup subtitle pattern: "7 nodes · root → leader → 4 tool calls".
  // We always have a root, and the first real child is typically a leader
  // response. We fall back gracefully if either shape is missing.
  const subtitle = (() => {
    const parts: string[] = [`${total} nodes`];
    const trail: string[] = ["root"];
    const firstChild = tree.children[0];
    if (firstChild) {
      const kind = kindLabel(firstChild.type) || firstChild.type;
      trail.push(kind || "leader");
    }
    if (toolCalls > 0) trail.push(`${toolCalls} tool calls`);
    parts.push(trail.join(" → "));
    return parts.join(" · ");
  })();

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <div className="task-tree">
      <div className="task-tree-head">
        <div className="task-tree-head-title">Execution tree</div>
        <div className="task-tree-head-sub">{subtitle}</div>
      </div>
      <div className="task-tree-list" role="tree">
        {flat.map(({ node, depth, hasChildren }) => {
          const isExpanded = expanded.has(node.id);
          const isActive = activeId === node.id;
          const chevron = hasChildren ? (isExpanded ? "▾" : "▸") : "·";
          const kind = kindLabel(node.type);
          return (
            <div
              key={node.id}
              role="treeitem"
              aria-expanded={hasChildren ? isExpanded : undefined}
              className={`task-tree-node task-tree-node--l${Math.min(depth, 4)}${isActive ? " task-tree-node--active" : ""}`}
              onClick={() => {
                if (hasChildren) toggle(node.id);
                setActiveId(node.id);
                onNodeClick(node.id);
              }}
            >
              <span className="task-tree-node__chevron">{chevron}</span>
              <span className="task-tree-node__label">
                {kind ? <span className="task-tree-node__kind">{kind}</span> : null}
                {kind ? " · " : null}
                {node.label}
              </span>
              <span className="task-tree-node__ticks">
                {node.state === "running" ? "running" : formatTime(node.startedAt)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
