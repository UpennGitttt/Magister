import { expect, test } from "bun:test";

import { WebSocketHub } from "../../src/ws/hub";

test("WebSocketHub initialises with zero state", () => {
  const hub = new WebSocketHub();
  expect(hub.getSeq()).toBe(0);
  expect(hub.getClientCount()).toBe(0);
});
