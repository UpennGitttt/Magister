import { areMagisterChannelsDisabled } from "../feishu/feishu-config";
import { parseSlackConfig, type SlackConfig } from "./slack-config";
import {
  normalizeSlackBlockActions,
  normalizeSlackEventsApiPayload,
} from "./slack-event-normalizer";
import { processChannelEvent } from "../../services/process-channel-event-service";

/**
 * Slack Socket Mode gateway — the Slack counterpart of
 * feishu-websocket-gateway.ts. Uses the app-level token (xapp) for the
 * WebSocket; all outbound replies go through slack-client (xoxb).
 *
 * Ack discipline: Slack requires an ack within 3s or it redelivers.
 * We ack IMMEDIATELY and process asynchronously — the inbound dedupe
 * table absorbs any redelivery that races a slow handler.
 */

type SlackEventArgs = {
  ack: (response?: unknown) => Promise<void>;
  body: unknown;
  event?: unknown;
  retry_num?: number;
};

type SocketModeClientLike = {
  on(eventName: string, listener: (args: SlackEventArgs) => void): unknown;
  start(): Promise<unknown>;
  disconnect(): Promise<void>;
};

type GatewayConnectionState = "idle" | "starting" | "running" | "stopped" | "error";

export type SlackSocketGatewayStatus = {
  disabled: boolean;
  configured: boolean;
  running: boolean;
  connectionState: GatewayConnectionState;
  startedAt: string | undefined;
  stoppedAt: string | undefined;
  lastError: string | undefined;
  messageEvents: number;
  interactiveEvents: number;
  lastInboundError: string | undefined;
  lastInboundEventType: string | undefined;
};

type SlackSocketGatewayRuntime = {
  createSocketModeClient?: (config: SlackConfig) => SocketModeClientLike;
  processInboundEvent?: typeof processChannelEvent;
  now?: () => Date;
};

const gatewayState: SlackSocketGatewayStatus = {
  disabled: false,
  configured: false,
  running: false,
  connectionState: "idle",
  startedAt: undefined,
  stoppedAt: undefined,
  lastError: undefined,
  messageEvents: 0,
  interactiveEvents: 0,
  lastInboundError: undefined,
  lastInboundEventType: undefined,
};

let socketClient: SocketModeClientLike | null = null;
let runtimeOverrides: SlackSocketGatewayRuntime = {};
let startPromise: Promise<SlackSocketGatewayStatus> | null = null;

function nowIso() {
  return (runtimeOverrides.now?.() ?? new Date()).toISOString();
}

async function buildSdkSocketModeClient(config: SlackConfig): Promise<SocketModeClientLike> {
  if (!config.appToken) {
    throw new Error("Slack Socket Mode gateway requires MAGISTER_SLACK_APP_TOKEN.");
  }
  const { SocketModeClient } = await import("@slack/socket-mode");
  return new SocketModeClient({ appToken: config.appToken }) as unknown as SocketModeClientLike;
}

function processEvent(normalized: NonNullable<ReturnType<typeof normalizeSlackEventsApiPayload>>) {
  return (runtimeOverrides.processInboundEvent ?? processChannelEvent)(normalized);
}

async function handleMessageEvent(args: SlackEventArgs, eventLabel: string) {
  gatewayState.messageEvents += 1;
  gatewayState.lastInboundEventType = eventLabel;
  await args.ack();
  try {
    const normalized = normalizeSlackEventsApiPayload(args.body);
    if (!normalized) return; // bot echo / edit / unsupported subtype
    await processEvent(normalized);
    gatewayState.lastInboundError = undefined;
  } catch (error) {
    gatewayState.lastInboundError = error instanceof Error ? error.message : String(error);
  }
}

async function handleInteractiveEvent(args: SlackEventArgs) {
  gatewayState.interactiveEvents += 1;
  gatewayState.lastInboundEventType = "interactive";
  // Ack first — Slack shows a spinner on the clicked button until then.
  await args.ack();
  try {
    const interaction = normalizeSlackBlockActions(args.body);
    if (!interaction) return;
    const { handleSlackBlockAction } = await import("../../services/slack/slack-router");
    await handleSlackBlockAction(interaction);
    gatewayState.lastInboundError = undefined;
  } catch (error) {
    gatewayState.lastInboundError = error instanceof Error ? error.message : String(error);
    // eslint-disable-next-line no-console
    console.error("[slack-gateway] interactive event failed:", gatewayState.lastInboundError);
  }
}

function syncGatewayStatus(config: SlackConfig) {
  gatewayState.disabled = areMagisterChannelsDisabled();
  gatewayState.configured = !gatewayState.disabled && Boolean(config.botToken && config.appToken);
}

async function closeSocketClientIfPresent() {
  if (socketClient) {
    try {
      await socketClient.disconnect();
    } catch {
      /* already down */
    }
    socketClient = null;
  }
}

export function getSlackSocketGatewayStatus(): SlackSocketGatewayStatus {
  syncGatewayStatus(parseSlackConfig());
  return { ...gatewayState };
}

export async function startSlackSocketGateway(): Promise<SlackSocketGatewayStatus> {
  const config = parseSlackConfig();
  syncGatewayStatus(config);

  if (gatewayState.disabled) {
    await closeSocketClientIfPresent();
    gatewayState.connectionState = "stopped";
    gatewayState.running = false;
    gatewayState.lastError = undefined;
    gatewayState.stoppedAt = nowIso();
    return getSlackSocketGatewayStatus();
  }

  // Unconfigured is the normal state for feishu-only operators — stay
  // idle silently instead of erroring like a missing-creds failure.
  if (!config.botToken || !config.appToken) {
    gatewayState.connectionState = "idle";
    gatewayState.running = false;
    return getSlackSocketGatewayStatus();
  }

  if (gatewayState.running) {
    return getSlackSocketGatewayStatus();
  }

  if (startPromise) {
    return await startPromise;
  }

  gatewayState.connectionState = "starting";
  gatewayState.lastError = undefined;

  startPromise = (async () => {
    const client =
      runtimeOverrides.createSocketModeClient?.(config) ?? (await buildSdkSocketModeClient(config));

    // events_api envelopes are re-emitted under the INNER event type.
    client.on("message", (args) => void handleMessageEvent(args, "message"));
    client.on("app_mention", (args) => void handleMessageEvent(args, "app_mention"));
    client.on("interactive", (args) => void handleInteractiveEvent(args));

    await client.start();
    socketClient = client;

    gatewayState.running = true;
    gatewayState.connectionState = "running";
    gatewayState.startedAt = nowIso();
    gatewayState.stoppedAt = undefined;

    return getSlackSocketGatewayStatus();
  })()
    .catch((error) => {
      gatewayState.running = false;
      gatewayState.connectionState = "error";
      gatewayState.lastError = error instanceof Error ? error.message : String(error);
      return getSlackSocketGatewayStatus();
    })
    .finally(() => {
      startPromise = null;
    });

  return await startPromise;
}

export async function stopSlackSocketGateway(): Promise<SlackSocketGatewayStatus> {
  await closeSocketClientIfPresent();

  gatewayState.running = false;
  gatewayState.connectionState = "stopped";
  gatewayState.stoppedAt = nowIso();

  return getSlackSocketGatewayStatus();
}

export function setSlackSocketGatewayRuntimeForTest(overrides?: SlackSocketGatewayRuntime) {
  runtimeOverrides = overrides ?? {};
  socketClient = null;
  startPromise = null;
  gatewayState.disabled = false;
  gatewayState.configured = false;
  gatewayState.running = false;
  gatewayState.connectionState = "idle";
  gatewayState.startedAt = undefined;
  gatewayState.stoppedAt = undefined;
  gatewayState.lastError = undefined;
  gatewayState.messageEvents = 0;
  gatewayState.interactiveEvents = 0;
  gatewayState.lastInboundError = undefined;
  gatewayState.lastInboundEventType = undefined;
}
