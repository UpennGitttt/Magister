import { afterEach, beforeEach, expect, mock, test } from "bun:test";

import {
  getFeishuWebSocketGatewayStatus,
  setFeishuWebSocketGatewayRuntimeForTest,
  startFeishuWebSocketGateway,
  stopFeishuWebSocketGateway,
} from "../../../src/integrations/feishu/feishu-websocket-gateway";

const ORIGINAL_ENV = {
  MAGISTER_DISABLE_CHANNELS: process.env.MAGISTER_DISABLE_CHANNELS,
  MAGISTER_FEISHU_CONNECTION_MODE: process.env.MAGISTER_FEISHU_CONNECTION_MODE,
  MAGISTER_FEISHU_APP_ID: process.env.MAGISTER_FEISHU_APP_ID,
  MAGISTER_FEISHU_APP_SECRET: process.env.MAGISTER_FEISHU_APP_SECRET,
};

function restoreEnvKey(key: keyof typeof ORIGINAL_ENV) {
  const value = ORIGINAL_ENV[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

beforeEach(() => {
  process.env.MAGISTER_FEISHU_CONNECTION_MODE = "websocket";
  process.env.MAGISTER_FEISHU_APP_ID = "cli-agent-app-id";
  process.env.MAGISTER_FEISHU_APP_SECRET = "cli-agent-app-secret";
});

afterEach(async () => {
  await stopFeishuWebSocketGateway();
  setFeishuWebSocketGatewayRuntimeForTest();
  restoreEnvKey("MAGISTER_DISABLE_CHANNELS");
  restoreEnvKey("MAGISTER_FEISHU_CONNECTION_MODE");
  restoreEnvKey("MAGISTER_FEISHU_APP_ID");
  restoreEnvKey("MAGISTER_FEISHU_APP_SECRET");
});

test("feishu websocket gateway starts in websocket mode and processes message events", async () => {
  const register = mock(() => dispatcher);
  const dispatcher = {
    register,
  };
  let messageHandler: ((data: unknown) => Promise<void> | void) | undefined;
  const createEventDispatcher = mock(() => ({
    register: (handlers: Record<string, (data: unknown) => Promise<void> | void>) => {
      messageHandler = handlers["im.message.receive_v1"];
      return dispatcher;
    },
  }));
  const createWSClient = mock(() => ({
    start: async () => {},
    close: () => {},
    getReconnectInfo: () => ({
      lastConnectTime: 111,
      nextConnectTime: 222,
    }),
  }));
  const processInboundEvent = mock(async () => {});

  setFeishuWebSocketGatewayRuntimeForTest({
    createEventDispatcher,
    createWSClient,
    processInboundEvent,
  });

  const status = await startFeishuWebSocketGateway();
  expect(status).toMatchObject({
    mode: "websocket",
    running: true,
    connectionState: "running",
    messageEvents: 0,
  });

  await messageHandler?.({
    event: {
      event_id: "evt_ws_message_1",
      tenant_key: "tenant_alpha",
      create_time: 1712820100000,
      sender: {
        sender_id: {
          open_id: "ou_sender_ws",
        },
        sender_name: "Yuhao",
      },
      message: {
        message_id: "om_message_ws_1",
        chat_id: "oc_chat_ws",
        chat_type: "p2p",
        message_type: "text",
        content: JSON.stringify({
          text: "ship websocket intake",
        }),
        create_time: 1712820103000,
      },
    },
  });

  expect(processInboundEvent).toHaveBeenCalledTimes(1);
  expect(getFeishuWebSocketGatewayStatus()).toMatchObject({
    messageEvents: 1,
    lastInboundEventType: "im.message.receive_v1",
    lastInboundError: undefined,
  });
});

test("feishu websocket gateway stays stopped in webhook mode", async () => {
  process.env.MAGISTER_FEISHU_CONNECTION_MODE = "webhook";

  const status = await startFeishuWebSocketGateway();

  expect(status).toMatchObject({
    mode: "webhook",
    running: false,
    connectionState: "stopped",
  });
});

test("feishu websocket gateway stays stopped when channels are disabled", async () => {
  process.env.MAGISTER_DISABLE_CHANNELS = "1";
  const createWSClient = mock(() => ({
    start: async () => {},
    close: () => {},
  }));
  setFeishuWebSocketGatewayRuntimeForTest({
    createWSClient,
    createEventDispatcher: () => {
      const dispatcher = {
        register: () => dispatcher,
      };
      return dispatcher;
    },
    processInboundEvent: mock(async () => {}),
  });

  const status = await startFeishuWebSocketGateway();

  expect(status).toMatchObject({
    disabled: true,
    running: false,
    connectionState: "stopped",
  });
  expect(createWSClient).not.toHaveBeenCalled();
});

test("feishu websocket gateway closes an existing client when channels become disabled", async () => {
  const close = mock(() => {});
  setFeishuWebSocketGatewayRuntimeForTest({
    createWSClient: () => ({
      start: async () => {},
      close,
    }),
    createEventDispatcher: () => {
      const dispatcher = {
        register: () => dispatcher,
      };
      return dispatcher;
    },
    processInboundEvent: mock(async () => {}),
  });

  await startFeishuWebSocketGateway();
  process.env.MAGISTER_DISABLE_CHANNELS = "1";

  const status = await startFeishuWebSocketGateway();

  expect(status).toMatchObject({
    disabled: true,
    running: false,
    connectionState: "stopped",
  });
  expect(close).toHaveBeenCalledWith({ force: true });
});
