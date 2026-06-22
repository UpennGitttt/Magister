import { beforeEach, describe, expect, test } from "bun:test";

import { useWSStore } from "./wsStore";

beforeEach(() => {
  useWSStore.setState({
    connected: false,
    lastSeq: 0,
    activeAgents: [],
    recentEvents: [],
  });
});

describe("wsStore", () => {
  describe("setConnected", () => {
    test("setConnected(false) clears activeAgents to []", () => {
      useWSStore.setState({
        connected: true,
        activeAgents: [
          {
            taskId: "task_1",
            agentId: "leader",
            role: "leader",
            currentAction: "thinking...",
            lastUpdate: "2026-06-01T00:00:00.000Z",
          },
        ],
      });

      useWSStore.getState().setConnected(false);

      const state = useWSStore.getState();
      expect(state.connected).toBe(false);
      expect(state.activeAgents).toEqual([]);
    });

    test("setConnected(true) preserves existing activeAgents", () => {
      const agents = [
        {
          taskId: "task_2",
          agentId: "leader",
          role: "leader",
          currentAction: "tool_call",
          lastUpdate: "2026-06-01T00:00:00.000Z",
        },
      ];
      useWSStore.setState({ connected: false, activeAgents: agents });

      useWSStore.getState().setConnected(true);

      const state = useWSStore.getState();
      expect(state.connected).toBe(true);
      expect(state.activeAgents).toEqual(agents);
    });
  });
});
