import * as crypto from "node:crypto";

import * as Lark from "@larksuiteoapi/node-sdk";

import { normalizeFeishuInboundEvent } from "./feishu-event-normalizer";
import { areMagisterChannelsDisabled, parseFeishuConfigFromEnv, type FeishuConfig } from "./feishu-config";
import { getMagisterEnv } from "../../lib/env";
import { processChannelEvent } from "../../services/process-channel-event-service";

type FeishuEventDispatcherLike = {
  register(handlers: Record<string, (data: unknown) => Promise<unknown> | unknown>): FeishuEventDispatcherLike;
};

type FeishuWsClientLike = {
  start(input: { eventDispatcher: FeishuEventDispatcherLike }): Promise<void> | void;
  close(input?: { force?: boolean }): void;
  getReconnectInfo?: () => {
    lastConnectTime?: number;
    nextConnectTime?: number;
  };
};

type GatewayConnectionState = "idle" | "starting" | "running" | "stopped" | "error";

export type FeishuWebSocketGatewayStatus = {
  mode: FeishuConfig["connectionMode"];
  disabled: boolean;
  configured: boolean;
  running: boolean;
  connectionState: GatewayConnectionState;
  startedAt: string | undefined;
  stoppedAt: string | undefined;
  lastError: string | undefined;
  messageEvents: number;
  cardActionEvents: number;
  reconnectInfo:
    | {
        lastConnectTime?: number;
        nextConnectTime?: number;
      }
    | undefined;
  lastInboundError: string | undefined;
  lastInboundEventType: string | undefined;
};

type FeishuWebSocketGatewayRuntime = {
  createWSClient?: (config: FeishuConfig) => FeishuWsClientLike;
  createEventDispatcher?: (config: FeishuConfig) => FeishuEventDispatcherLike;
  processInboundEvent?: ReturnType<typeof normalizeFeishuInboundEvent> extends infer T
    ? (event: T) => Promise<unknown>
    : never;
  now?: () => Date;
  uuid?: () => string;
};

const gatewayState: FeishuWebSocketGatewayStatus = {
  mode: "websocket",
  disabled: false,
  configured: false,
  running: false,
  connectionState: "idle",
  startedAt: undefined,
  stoppedAt: undefined,
  lastError: undefined,
  messageEvents: 0,
  cardActionEvents: 0,
  reconnectInfo: undefined,
  lastInboundError: undefined,
  lastInboundEventType: undefined,
};

let wsClient: FeishuWsClientLike | null = null;
let runtimeOverrides: FeishuWebSocketGatewayRuntime = {};
let startPromise: Promise<FeishuWebSocketGatewayStatus> | null = null;

function nowIso() {
  return (runtimeOverrides.now?.() ?? new Date()).toISOString();
}

function nextUuid() {
  return runtimeOverrides.uuid?.() ?? crypto.randomUUID();
}

function buildSdkEventDispatcher(config: FeishuConfig): FeishuEventDispatcherLike {
  return new Lark.EventDispatcher({
    loggerLevel: Lark.LoggerLevel.info,
    ...(config.verificationToken ? { verificationToken: config.verificationToken } : {}),
    ...(config.encryptKey ? { encryptKey: config.encryptKey } : {}),
  }) as FeishuEventDispatcherLike;
}

function buildSdkWsClient(config: FeishuConfig): FeishuWsClientLike {
  if (!config.appId || !config.appSecret) {
    throw new Error("Feishu WebSocket gateway requires appId and appSecret.");
  }

  return new Lark.WSClient({
    appId: config.appId,
    appSecret: config.appSecret,
    loggerLevel: Lark.LoggerLevel.info,
  }) as unknown as FeishuWsClientLike;
}

function wrapMessageEvent(data: Record<string, unknown>) {
  if (data.header && data.event) {
    return data;
  }

  const nestedEvent =
    data.event && typeof data.event === "object" && !Array.isArray(data.event)
      ? (data.event as Record<string, unknown>)
      : null;

  return {
    schema: "2.0",
    header: {
      event_id:
        typeof data.event_id === "string"
          ? data.event_id
          : typeof nestedEvent?.event_id === "string"
            ? nestedEvent.event_id
            : `evt_ws_${nextUuid()}`,
      event_type: "im.message.receive_v1",
      tenant_key:
        typeof data.tenant_key === "string"
          ? data.tenant_key
          : typeof nestedEvent?.tenant_key === "string"
            ? nestedEvent.tenant_key
            : "feishu_ws_default_account",
      create_time:
        typeof data.create_time === "string" || typeof data.create_time === "number"
          ? data.create_time
          : typeof nestedEvent?.create_time === "string" || typeof nestedEvent?.create_time === "number"
            ? nestedEvent.create_time
            : String(Date.now()),
    },
    event: {
      sender: nestedEvent?.sender ?? data.sender,
      message: nestedEvent?.message ?? data.message,
    },
  };
}

function wrapCardActionEvent(data: Record<string, unknown>) {
  if (data.action && (data.open_chat_id || data.context || data.tenant_key)) {
    return data;
  }

  const nestedEvent =
    data.event && typeof data.event === "object" && !Array.isArray(data.event)
      ? (data.event as Record<string, unknown>)
      : null;

  return {
    event_id:
      typeof data.event_id === "string"
        ? data.event_id
        : typeof nestedEvent?.event_id === "string"
          ? nestedEvent.event_id
          : `evt_card_${nextUuid()}`,
    tenant_key:
      typeof data.tenant_key === "string"
        ? data.tenant_key
        : typeof nestedEvent?.tenant_key === "string"
          ? nestedEvent.tenant_key
          : "feishu_ws_default_account",
    action_time:
      typeof data.action_time === "string" || typeof data.action_time === "number"
        ? data.action_time
        : typeof nestedEvent?.action_time === "string" || typeof nestedEvent?.action_time === "number"
          ? nestedEvent.action_time
          : String(Date.now()),
    open_message_id:
      typeof data.open_message_id === "string"
        ? data.open_message_id
        : typeof nestedEvent?.open_message_id === "string"
          ? nestedEvent.open_message_id
          : undefined,
    open_chat_id:
      typeof data.open_chat_id === "string"
        ? data.open_chat_id
        : typeof nestedEvent?.open_chat_id === "string"
          ? nestedEvent.open_chat_id
          : undefined,
    operator: nestedEvent?.operator ?? data.operator,
    action: nestedEvent?.action ?? data.action,
    context: nestedEvent?.context ?? data.context,
  };
}

async function processNormalizedEvent(rawPayload: unknown): Promise<unknown> {
  const normalized = normalizeFeishuInboundEvent(rawPayload);
  const result = await (runtimeOverrides.processInboundEvent ?? processChannelEvent)(normalized);
  gatewayState.lastInboundError = undefined;
  return result;
}

function syncGatewayStatus(config: FeishuConfig) {
  gatewayState.mode = config.connectionMode;
  gatewayState.disabled = areMagisterChannelsDisabled();
  gatewayState.configured = !gatewayState.disabled && Boolean(config.appId && config.appSecret);
}

function captureReconnectInfo() {
  gatewayState.reconnectInfo = wsClient?.getReconnectInfo?.();
}

function closeWsClientIfPresent() {
  if (wsClient) {
    wsClient.close({ force: true });
    wsClient = null;
  }
}

export function getFeishuWebSocketGatewayStatus(): FeishuWebSocketGatewayStatus {
  syncGatewayStatus(parseFeishuConfigFromEnv());
  captureReconnectInfo();
  return { ...gatewayState };
}

export async function startFeishuWebSocketGateway(): Promise<FeishuWebSocketGatewayStatus> {
  const config = parseFeishuConfigFromEnv();
  syncGatewayStatus(config);

  if (gatewayState.disabled) {
    closeWsClientIfPresent();
    gatewayState.connectionState = "stopped";
    gatewayState.running = false;
    gatewayState.lastError = undefined;
    gatewayState.stoppedAt = nowIso();
    return getFeishuWebSocketGatewayStatus();
  }

  if (config.connectionMode !== "websocket") {
    gatewayState.connectionState = "stopped";
    gatewayState.running = false;
    gatewayState.lastError = undefined;
    gatewayState.stoppedAt = nowIso();
    return getFeishuWebSocketGatewayStatus();
  }

  if (!config.appId || !config.appSecret) {
    gatewayState.connectionState = "error";
    gatewayState.running = false;
    gatewayState.lastError = "Feishu websocket mode requires appId and appSecret.";
    return getFeishuWebSocketGatewayStatus();
  }

  if (gatewayState.running) {
    return getFeishuWebSocketGatewayStatus();
  }

  if (startPromise) {
    return await startPromise;
  }

  gatewayState.connectionState = "starting";
  gatewayState.lastError = undefined;

  startPromise = (async () => {
    const eventDispatcher =
      runtimeOverrides.createEventDispatcher?.(config) ?? buildSdkEventDispatcher(config);

    eventDispatcher.register({
      "im.message.receive_v1": async (data: unknown) => {
        gatewayState.messageEvents += 1;
        gatewayState.lastInboundEventType = "im.message.receive_v1";
        try {
          await processNormalizedEvent(wrapMessageEvent(data as Record<string, unknown>));
        } catch (error) {
          gatewayState.lastInboundError =
            error instanceof Error ? error.message : String(error);
        }
      },
      "card.action.trigger": async (data: unknown) => {
        gatewayState.cardActionEvents += 1;
        gatewayState.lastInboundEventType = "card.action.trigger";
        // Feishu's card.action.trigger REQUIRES a callback-response
        // payload — without it the client shows error 200340 ("卡片
        // Processing failure"). On internal processing failure we
        // return an error toast so the user sees feedback at the
        // protocol level; downstream work is asynchronous.
        //
        // Optional payload-shape log for debugging card.action shape
        // mismatches. Gated by MAGISTER_FEISHU_DEBUG so production stdout
        // isn't flooded. Top-level field names only, no body content.
        const dataObj = (data && typeof data === "object" ? data : {}) as Record<string, unknown>;
        if (getMagisterEnv("MAGISTER_FEISHU_DEBUG") === "1") {
          // eslint-disable-next-line no-console
          console.log(
            "[ws.card.action.trigger] raw keys:",
            JSON.stringify({
              keys: Object.keys(dataObj),
              hasSchema: dataObj.schema,
              hasHeader: !!dataObj.header,
              hasEvent: !!dataObj.event,
              hasAction: !!dataObj.action,
              hasOperator: !!dataObj.operator,
            }),
          );
        }
        const result = await (async () => {
          try {
            const intake = await processNormalizedEvent(wrapCardActionEvent(dataObj));
            // If the intake returned a card-replacement payload, send
            // it back as the WS handler response so Feishu updates the
            // visible card in-place (replaces the buttons with the
            // resolved state). This is the only way to get "click ⇒
            // card mutates" UX without round-tripping a second API
            // call to send a new card.
            const intakeObj = intake as Record<string, unknown> | null | undefined;
            const intakePayload = intakeObj?.intake as Record<string, unknown> | undefined;
            const cardResponse = intakePayload?.cardResponse as object | undefined;
            if (cardResponse) {
              return cardResponse;
            }
            return { toast: { type: "success", content: "Acknowledged" } };
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            gatewayState.lastInboundError = msg;
            // eslint-disable-next-line no-console
            console.error("[ws.card.action.trigger] processing failed:", msg);
            return { toast: { type: "error", content: "Processing failed" } };
          }
        })();
        return result;
      },
    });

    wsClient = runtimeOverrides.createWSClient?.(config) ?? buildSdkWsClient(config);
    await wsClient.start({ eventDispatcher });

    gatewayState.running = true;
    gatewayState.connectionState = "running";
    gatewayState.startedAt = nowIso();
    gatewayState.stoppedAt = undefined;
    captureReconnectInfo();

    return getFeishuWebSocketGatewayStatus();
  })()
    .catch((error) => {
      gatewayState.running = false;
      gatewayState.connectionState = "error";
      gatewayState.lastError = error instanceof Error ? error.message : String(error);
      captureReconnectInfo();
      return getFeishuWebSocketGatewayStatus();
    })
    .finally(() => {
      startPromise = null;
    });

  return await startPromise;
}

export async function stopFeishuWebSocketGateway(): Promise<FeishuWebSocketGatewayStatus> {
  closeWsClientIfPresent();

  gatewayState.running = false;
  gatewayState.connectionState = "stopped";
  gatewayState.stoppedAt = nowIso();
  captureReconnectInfo();

  return getFeishuWebSocketGatewayStatus();
}

export function setFeishuWebSocketGatewayRuntimeForTest(overrides?: FeishuWebSocketGatewayRuntime) {
  runtimeOverrides = overrides ?? {};
  wsClient = null;
  startPromise = null;
  gatewayState.mode = "websocket";
  gatewayState.disabled = false;
  gatewayState.configured = false;
  gatewayState.running = false;
  gatewayState.connectionState = "idle";
  gatewayState.startedAt = undefined;
  gatewayState.stoppedAt = undefined;
  gatewayState.lastError = undefined;
  gatewayState.messageEvents = 0;
  gatewayState.cardActionEvents = 0;
  gatewayState.reconnectInfo = undefined;
  gatewayState.lastInboundError = undefined;
  gatewayState.lastInboundEventType = undefined;
}
