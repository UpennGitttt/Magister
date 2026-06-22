import { expect, test } from "bun:test";

import { isConversationalShortcutTextWithOptions } from "../../src/services/conversation-shortcut-service";

test("strict conversational shortcut policy treats short confirmation phrases as local conversation", () => {
  expect(
    isConversationalShortcutTextWithOptions("是么。", {
      policy: "strict",
    }),
  ).toBe(true);
});
