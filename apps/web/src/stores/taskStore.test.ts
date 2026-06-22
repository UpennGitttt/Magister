import { beforeEach, expect, test } from "bun:test";

import { setCurrentSelectedTaskId } from "./currentRoute";
import { useTaskStore } from "./taskStore";

beforeEach(() => {
  useTaskStore.setState({
    tasks: [],
    loading: false,
    error: null,
    isWaitingForResponse: false,
    chatRefreshCounter: 0,
  });
  setCurrentSelectedTaskId(null);
});

test("refreshChat increments chatRefreshCounter", () => {
  useTaskStore.getState().refreshChat();
  expect(useTaskStore.getState().chatRefreshCounter).toBe(1);

  useTaskStore.getState().refreshChat();
  expect(useTaskStore.getState().chatRefreshCounter).toBe(2);
});

test("completeSend clears waiting state and increments chatRefreshCounter when URL points at the same task", () => {
  setCurrentSelectedTaskId("task_1");
  useTaskStore.setState({
    isWaitingForResponse: true,
    chatRefreshCounter: 3,
  });

  useTaskStore.getState().completeSend("task_1");

  const state = useTaskStore.getState();
  expect(state.isWaitingForResponse).toBe(false);
  expect(state.chatRefreshCounter).toBe(4);
});

test("completeSend does nothing for a different task", () => {
  setCurrentSelectedTaskId("task_1");
  useTaskStore.setState({
    isWaitingForResponse: true,
    chatRefreshCounter: 3,
  });

  useTaskStore.getState().completeSend("task_99");

  const state = useTaskStore.getState();
  expect(state.isWaitingForResponse).toBe(true);
  expect(state.chatRefreshCounter).toBe(3);
});

test("setWaitingForResponse toggles flag", () => {
  useTaskStore.getState().setWaitingForResponse(true);
  expect(useTaskStore.getState().isWaitingForResponse).toBe(true);
  useTaskStore.getState().setWaitingForResponse(false);
  expect(useTaskStore.getState().isWaitingForResponse).toBe(false);
});
