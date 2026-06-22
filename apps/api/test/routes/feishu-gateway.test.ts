import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import { buildApp } from "../../src/app";
import {
  setFeishuWebSocketGatewayRuntimeForTest,
  stopFeishuWebSocketGateway,
} from "../../src/integrations/feishu/feishu-websocket-gateway";

const ORIGINAL_ENV = {
  MAGISTER_FEISHU_CONNECTION_MODE: process.env.MAGISTER_FEISHU_CONNECTION_MODE,
  MAGISTER_FEISHU_APP_ID: process.env.MAGISTER_FEISHU_APP_ID,
  MAGISTER_FEISHU_APP_SECRET: process.env.MAGISTER_FEISHU_APP_SECRET,
};

beforeEach(() => {
  process.env.MAGISTER_FEISHU_CONNECTION_MODE = "websocket";
  process.env.MAGISTER_FEISHU_APP_ID = "cli-agent-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "cli-agent-app-secret";
});

afterEach(async () => {
  await stopFeishuWebSocketGateway();
  setFeishuWebSocketGatewayRuntimeForTest();
  process.env.MAGISTER_FEISHU_CONNECTION_MODE = ORIGINAL_ENV.MAGISTER_FEISHU_CONNECTION_MODE;
  process.env.MAGISTER_FEISHU_APP_ID = ORIGINAL_ENV.MAGISTER_FEISHU_APP_ID;
  process.env.MAGISTER_FEISHU_APP_SECRET = ORIGINAL_ENV.MAGISTER_FEISHU_APP_SECRET;
});

test("POST /feishu/gateway/start starts websocket gateway and GET /feishu/gateway/status reports it", async () => {
  setFeishuWebSocketGatewayRuntimeForTest({
    createEventDispatcher: () => {
      const dispatcher = {
        register: () => dispatcher,
      };
      return dispatcher;
    },
    createWSClient: () => ({
      start: async () => {},
      close: () => {},
      getReconnectInfo: () => ({
        lastConnectTime: 12,
        nextConnectTime: 34,
      }),
    }),
    processInboundEvent: mock(async () => {}),
  });

  const app = buildApp();

  const startResponse = await app.inject({
    method: "POST",
    url: "/feishu/gateway/start",
  });

  expect(startResponse.statusCode).toBe(200);
  expect(startResponse.json()).toMatchObject({
    ok: true,
    data: {
      mode: "websocket",
      running: true,
      connectionState: "running",
    },
  });

  const statusResponse = await app.inject({
    method: "GET",
    url: "/feishu/gateway/status",
  });

  expect(statusResponse.statusCode).toBe(200);
  expect(statusResponse.json()).toMatchObject({
    ok: true,
    data: {
      mode: "websocket",
      running: true,
      connectionState: "running",
      reconnectInfo: {
        lastConnectTime: 12,
        nextConnectTime: 34,
      },
    },
  });
});
