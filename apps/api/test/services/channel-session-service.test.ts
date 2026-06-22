import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";

import { ChannelSessionService } from "../../src/services/channel-session-service";
import { createFeishuTestHarness, type FeishuTestHarness } from "../utils/feishu-test-harness";

let harness: FeishuTestHarness;

beforeEach(() => {
  harness = createFeishuTestHarness({
    name: "channel-session-service",
  });
});

afterEach(() => {
  harness.cleanup();
});

test("ensureForBinding persists verbose_level=high by default", async () => {
  // New default (2026-05-18): high. New channel sessions get the
  // streaming card with tool calls out of the box; operators who don't
  // want the noise run `/verbose off`.
  const service = new ChannelSessionService();

  await service.ensureForBinding({
    bindingId: "feishu:tenant_alpha:oc_chat_default_verbose",
    channel: "feishu",
    workspaceId: "workspace_main",
  });

  const sqlite = new Database(harness.dbPath);
  const row = sqlite
    .query("select verbose_level from channel_sessions where binding_id = ?")
    .get("feishu:tenant_alpha:oc_chat_default_verbose") as {
    verbose_level: string | null;
  };
  sqlite.close();

  expect(row.verbose_level).toBe("high");
});

test("ensureForBinding accepts an explicit verboseLevel", async () => {
  const service = new ChannelSessionService();

  await service.ensureForBinding({
    bindingId: "feishu:tenant_alpha:oc_chat_full_verbose",
    channel: "feishu",
    workspaceId: "workspace_main",
    verboseLevel: "full",
  });

  const sqlite = new Database(harness.dbPath);
  const row = sqlite
    .query("select verbose_level from channel_sessions where binding_id = ?")
    .get("feishu:tenant_alpha:oc_chat_full_verbose") as {
    verbose_level: string | null;
  };
  sqlite.close();

  expect(row.verbose_level).toBe("full");
});

test("updateVerboseLevel updates the stored channel session verbose level", async () => {
  const service = new ChannelSessionService();

  await service.ensureForBinding({
    bindingId: "feishu:tenant_alpha:oc_chat_update_verbose",
    channel: "feishu",
    workspaceId: "workspace_main",
  });

  await (
    service as unknown as {
      updateVerboseLevel: (bindingId: string, verboseLevel: string) => Promise<unknown>;
    }
  ).updateVerboseLevel("feishu:tenant_alpha:oc_chat_update_verbose", "on");

  const sqlite = new Database(harness.dbPath);
  const row = sqlite
    .query("select verbose_level from channel_sessions where binding_id = ?")
    .get("feishu:tenant_alpha:oc_chat_update_verbose") as {
    verbose_level: string | null;
  };
  sqlite.close();

  expect(row.verbose_level).toBe("on");
});
