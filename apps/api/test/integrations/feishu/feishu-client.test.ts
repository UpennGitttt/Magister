import { beforeEach, expect, test } from "bun:test";

import { createFeishuClient, resetFeishuTokenCache } from "../../../src/integrations/feishu/feishu-client";

beforeEach(() => {
  resetFeishuTokenCache();
});

function createJsonResponse(body: unknown, init?: ResponseInit) {
  return new Response(JSON.stringify(body), {
    headers: {
      "content-type": "application/json",
    },
    status: 200,
    ...init,
  });
}

test("feishu client gets tenant access token with app credentials", async () => {
  const requests: Array<{
    url: string;
    method: string;
    body: string;
    headers: Headers;
  }> = [];

  const client = createFeishuClient({
    appId: "cli_agent_app_id",
    appSecret: "cli_agent_app_secret",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
      });

      return createJsonResponse({
        code: 0,
        tenant_access_token: "tenant_access_token_value",
        expire: 7200,
      });
    },
  });

  const token = await client.getTenantAccessToken();

  expect(token).toBe("tenant_access_token_value");
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({
    url: "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
    method: "POST",
  });
  expect(requests[0]?.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(requests[0]?.body ?? "{}")).toEqual({
    app_id: "cli_agent_app_id",
    app_secret: "cli_agent_app_secret",
  });
});

test("feishu client sends a plain text message to chat_id using tenant access token", async () => {
  const requests: Array<{
    url: string;
    method: string;
    body: string;
    headers: Headers;
  }> = [];

  const client = createFeishuClient({
    appId: "cli_agent_app_id",
    appSecret: "cli_agent_app_secret",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
      });

      if (String(url).includes("/tenant_access_token/internal")) {
        return createJsonResponse({
          code: 0,
          tenant_access_token: "tenant_access_token_value",
          expire: 7200,
        });
      }

      return createJsonResponse({
        code: 0,
        data: {
          message_id: "om_text_message_123",
        },
      });
    },
  });

  const result = await client.sendTextMessage({
    chatId: "oc_chat_123",
    text: "hello from ultimate coding manager",
  });

  expect(result).toEqual({
    messageId: "om_text_message_123",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    url: "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=chat_id",
    method: "POST",
  });
  expect(requests[1]?.headers.get("authorization")).toBe(
    "Bearer tenant_access_token_value",
  );
  expect(requests[1]?.headers.get("content-type")).toBe("application/json");
  expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
    receive_id: "oc_chat_123",
    msg_type: "text",
    content: JSON.stringify({
      text: "hello from ultimate coding manager",
    }),
  });
});

test("feishu client replies to an existing message_id", async () => {
  const requests: Array<{
    url: string;
    method: string;
    body: string;
    headers: Headers;
  }> = [];

  const client = createFeishuClient({
    appId: "cli_agent_app_id",
    appSecret: "cli_agent_app_secret",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
      });

      if (String(url).includes("/tenant_access_token/internal")) {
        return createJsonResponse({
          code: 0,
          tenant_access_token: "tenant_access_token_value",
          expire: 7200,
        });
      }

      return createJsonResponse({
        code: 0,
        data: {
          message_id: "om_reply_message_123",
        },
      });
    },
  });

  const result = await client.replyTextMessage({
    messageId: "om_parent_message",
    text: "follow-up reply",
  });

  expect(result).toEqual({
    messageId: "om_reply_message_123",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    url: "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_message/reply",
    method: "POST",
  });
  expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
    msg_type: "text",
    content: JSON.stringify({
      text: "follow-up reply",
    }),
  });
});

test("feishu client adds an OK reaction to an existing message_id", async () => {
  const requests: Array<{
    url: string;
    method: string;
    body: string;
    headers: Headers;
  }> = [];

  const client = createFeishuClient({
    appId: "cli_agent_app_id",
    appSecret: "cli_agent_app_secret",
    fetchImpl: async (url, init) => {
      requests.push({
        url: String(url),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? init.body : "",
        headers: new Headers(init?.headers),
      });

      if (String(url).includes("/tenant_access_token/internal")) {
        return createJsonResponse({
          code: 0,
          tenant_access_token: "tenant_access_token_value",
          expire: 7200,
        });
      }

      return createJsonResponse({
        code: 0,
        data: {
          reaction_id: "reaction_ok_123",
        },
      });
    },
  });

  const result = await client.addMessageReaction({
    messageId: "om_parent_message",
    emojiType: "OK",
  });

  expect(result).toEqual({
    reactionId: "reaction_ok_123",
  });
  expect(requests).toHaveLength(2);
  expect(requests[1]).toMatchObject({
    url: "https://open.feishu.cn/open-apis/im/v1/messages/om_parent_message/reactions",
    method: "POST",
  });
  expect(JSON.parse(requests[1]?.body ?? "{}")).toEqual({
    reaction_type: {
      emoji_type: "OK",
    },
  });
});
