import { useParams, useNavigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { getTaskTree } from "../lib/api";
import type { TaskTreeResponse, TaskTreeNode } from "../lib/types";
import { TaskHeader } from "../components/task/TaskHeader";
import { TaskTreePanel } from "../components/task/TaskTreePanel";
import { ExecutionTimeline } from "../components/task/ExecutionTimeline";
import { NodeDetail } from "../components/task/NodeDetail";
import "../styles/task-detail.css";

function findNode(root: TaskTreeNode, id: string): TaskTreeNode | null {
  if (root.id === id) return root;
  for (const child of root.children) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export function TaskDetailPage() {
  const { taskId } = useParams();
  const navigate = useNavigate();
  const [tree, setTree] = useState<TaskTreeResponse | null>(null);
  const [treeError, setTreeError] = useState<string | null>(null);
  const [highlightedNodeId, setHighlightedNodeId] = useState<string | null>(null);
  const [selectedNode, setSelectedNode] = useState<TaskTreeNode | null>(null);

  useEffect(() => {
    if (!taskId) return;
    let stale = false;
    setTree(null);
    setTreeError(null);
    setSelectedNode(null);
    getTaskTree(taskId)
      .then((data) => { if (!stale) setTree(data); })
      .catch((err) => {
        if (!stale) setTreeError(err instanceof Error ? err.message : "Failed to load task tree");
      });
    return () => { stale = true; };
  }, [taskId]);

  if (!taskId) {
    return (
      <div className="page">
        <p style={{ color: "var(--muted)" }}>Select a task from the Dashboard.</p>
      </div>
    );
  }

  return (
    <div className="page">
      <TaskHeader taskId={taskId} tree={tree} onBack={() => navigate("/")} />
      <div className="task-detail-panels">
        <div className="task-detail-split">
          <aside className="task-tree-panel">
            {(treeError || !tree) && (
              <div className="task-tree">
                <div className="task-tree-head">
                  <div className="task-tree-head-title">Execution tree</div>
                  <div className="task-tree-head-sub">
                    {treeError ? "error" : "loading…"}
                  </div>
                </div>
                <p
                  style={{
                    color: treeError ? "var(--red)" : "var(--ink-3)",
                    padding: "12px 18px",
                    fontFamily: "var(--font-mono)",
                    fontSize: 11.5,
                  }}
                >
                  {treeError ?? "Loading tree…"}
                </p>
              </div>
            )}
            {tree && (
              <TaskTreePanel
                tree={tree.root}
                onNodeClick={(id) => {
                  const node = findNode(tree.root, id);
                  setSelectedNode(node);
                  setHighlightedNodeId(id);
                }}
              />
            )}
          </aside>
          <section className="task-detail-panel-side">
            {selectedNode ? (
              <NodeDetail node={selectedNode} />
            ) : tree ? (
              <NodeDetail node={tree.root} />
            ) : (
              <div className="node-detail-empty">
                <p>Click a node in the tree to see details</p>
              </div>
            )}
          </section>
        </div>
        <div className="task-timeline-panel">
          <ExecutionTimeline taskId={taskId} highlightedNodeId={highlightedNodeId} />
        </div>
      </div>
    </div>
  );
}
