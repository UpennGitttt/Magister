#!/usr/bin/env bun
/**
 * Smoke test for the Feishu approval card outbound path.
 *
 * Sends a card with the EXACT payload feishu-approval-outbound-service
 * builds, and prints the raw API response so we can see whether the
 * format is accepted (HTTP 200 + message_id) or rejected (HTTP 400 +
 * specific error code/message).
 *
 * Why: I've been pushing card-format fixes blindly. Two prior fixes
 * landed without actually verifying the API accepts the new payload.
 * This script makes verification deterministic — run it after each
 * code change, see the result before claiming a fix.
 *
 * Usage:
 *   bun scripts/feishu-card-smoke-test.ts <chat-id>
 *
 * Where <chat-id> is the open_chat_id of the conversation to receive
 * the test card. Find it in the running Magister's conversation_bindings
 * table: sqlite .local/control-plane.sqlite "SELECT chat_id FROM
 * conversation_bindings WHERE channel='feishu' LIMIT 1"
 */
import { createHmac, randomUUID } from "node:crypto";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

// Load .env from repo root (same pattern serve-prod.ts uses)
const envPath = resolve(import.meta.dir, "../.env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf-8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq < 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!process.env[key]) process.env[key] = value;
  }
}

const chatId = process.argv[2];
if (!chatId) {
  console.error("usage: bun scripts/feishu-card-smoke-test.ts <chat-id>");
  process.exit(1);
}

const APP_ID = process.env.MAGISTER_FEISHU_APP_ID;
const APP_SECRET = process.env.MAGISTER_FEISHU_APP_SECRET;
if (!APP_ID || !APP_SECRET) {
  console.error("missing MAGISTER_FEISHU_APP_ID or MAGISTER_FEISHU_APP_SECRET in env");
  process.exit(1);
}

const APPROVAL_SECRET = process.env.MAGISTER_FEISHU_APPROVAL_SECRET?.trim() || "magister-approval-secret-change-me";
const BASE = "https://open.feishu.cn";

async function getToken(): Promise<string> {
  const res = await fetch(`${BASE}/open-apis/auth/v3/tenant_access_token/internal`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: APP_ID, app_secret: APP_SECRET }),
  });
  const data = (await res.json()) as Record<string, unknown>;
  if (data.code !== 0) throw new Error(`token failed: ${JSON.stringify(data)}`);
  return data.tenant_access_token as string;
}

function buildEnvelope(action: "approval.approve" | "approval.reject", approvalId: string): Record<string, unknown> {
  const c = {
    s: approvalId,
    h: chatId,
    e: Date.now() + 5 * 60_000,
    t: "group" as const,
  };
  const base = { k: "button" as const, a: action, c };
  const canonical = [
    `k=${base.k}`,
    `a=${base.a}`,
    `c.s=${c.s}`,
    `c.h=${c.h}`,
    `c.e=${c.e}`,
    `c.t=${c.t}`,
  ].join("\n");
  const sig = createHmac("sha256", APPROVAL_SECRET).update(canonical).digest("hex");
  return { oc: "ocf1", ...base, sig };
}

function buildCard(): object {
  const approvalId = `approval_${randomUUID()}`;
  const approveEnv = buildEnvelope("approval.approve", approvalId);
  const rejectEnv = buildEnvelope("approval.reject", approvalId);
  return {
    config: { wide_screen_mode: true },
    header: {
      title: { tag: "plain_text", content: "🔒 [SMOKE TEST] Approval needed" },
      template: "orange",
    },
    elements: [
      {
        tag: "div",
        text: {
          tag: "lark_md",
          content: [
            "**bash** (test card from smoke test)",
            "```",
            "rm -rf /tmp/smoke-test-target",
            "```",
            "**Reason:** verify Feishu accepts this payload shape",
            "",
            `<font color='grey'>approval ${approvalId.slice(-8)} · expires in 5m</font>`,
          ].join("\n"),
        },
      },
      {
        tag: "action",
        actions: [
          {
            tag: "button",
            text: { tag: "plain_text", content: "✅ Approve" },
            type: "primary",
            value: { envelope: JSON.stringify(approveEnv) },
          },
          {
            tag: "button",
            text: { tag: "plain_text", content: "❌ Reject" },
            type: "danger",
            value: { envelope: JSON.stringify(rejectEnv) },
          },
        ],
      },
    ],
  };
}

async function main() {
  console.log("[1/3] Fetching tenant access token…");
  const token = await getToken();
  console.log("      OK");

  const card = buildCard();
  console.log("[2/3] Card payload to send:");
  console.log(JSON.stringify(card, null, 2));
  console.log();

  console.log(`[3/3] POST /im/v1/messages?receive_id_type=chat_id (chat=${chatId})…`);
  const sendRes = await fetch(
    `${BASE}/open-apis/im/v1/messages?receive_id_type=chat_id`,
    {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        receive_id: chatId,
        msg_type: "interactive",
        content: JSON.stringify(card),
      }),
    },
  );
  const body = await sendRes.text();
  console.log(`      HTTP ${sendRes.status}`);
  console.log(`      body: ${body}`);

  try {
    const parsed = JSON.parse(body) as Record<string, unknown>;
    if (parsed.code === 0) {
      console.log("\n✅ Card sent successfully. message_id:", (parsed.data as Record<string, unknown>)?.message_id);
      console.log("   Click the buttons in Feishu and run:");
      console.log("   curl -s http://localhost:3700/feishu/gateway/status | python3 -c \"import json,sys;d=json.load(sys.stdin)['data'];print('card:',d.get('cardActionEvents'),'last:',d.get('lastInboundEventType'))\"");
    } else {
      console.log("\n❌ Feishu rejected the card. Code:", parsed.code, "Message:", parsed.msg);
      console.log("   This means the card-format assumption is wrong.");
    }
  } catch {
    console.log("\n⚠️  Could not parse response as JSON");
  }
}

main().catch((err) => {
  console.error("\n💥 smoke test crashed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
