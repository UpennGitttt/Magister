import { WebClient } from "@slack/web-api";

export type CreateSlackClientOptions = {
  botToken: string;
};

export type SlackPostMessageInput = {
  channel: string;
  text: string;
  /** Reply inside a thread when set (parent message's ts). */
  threadTs?: string | undefined;
  /** Block Kit blocks; `text` becomes the notification fallback. */
  blocks?: unknown[] | undefined;
};

export type SlackPostMessageResult = {
  channel: string;
  ts: string;
};

export type SlackUpdateMessageInput = {
  channel: string;
  ts: string;
  text: string;
  blocks?: unknown[] | undefined;
};

export type SlackClient = {
  postMessage(input: SlackPostMessageInput): Promise<SlackPostMessageResult>;
  updateMessage(input: SlackUpdateMessageInput): Promise<SlackPostMessageResult>;
  /** auth.test — used by setup test-connection. Throws on bad token. */
  authTest(): Promise<{ botUserId: string; team: string }>;
};

/**
 * Thin wrapper over @slack/web-api so services depend on OUR surface,
 * not the SDK's (mirrors feishu-client.ts). The SDK already handles
 * rate-limit retries (HTTP 429 + Retry-After) internally.
 */
export function createSlackClient(options: CreateSlackClientOptions): SlackClient {
  const web = new WebClient(options.botToken);

  return {
    async postMessage(input) {
      const result = await web.chat.postMessage({
        channel: input.channel,
        text: input.text,
        ...(input.threadTs ? { thread_ts: input.threadTs } : {}),
        ...(input.blocks ? { blocks: input.blocks as never } : {}),
      });
      if (!result.ok || !result.ts) {
        throw new Error(`Slack chat.postMessage failed: ${result.error ?? "unknown"}`);
      }
      return { channel: (result.channel as string) ?? input.channel, ts: result.ts };
    },

    async updateMessage(input) {
      const result = await web.chat.update({
        channel: input.channel,
        ts: input.ts,
        text: input.text,
        ...(input.blocks ? { blocks: input.blocks as never } : {}),
      });
      if (!result.ok || !result.ts) {
        throw new Error(`Slack chat.update failed: ${result.error ?? "unknown"}`);
      }
      return { channel: (result.channel as string) ?? input.channel, ts: result.ts };
    },

    async authTest() {
      const result = await web.auth.test();
      if (!result.ok) {
        throw new Error(`Slack auth.test failed: ${result.error ?? "unknown"}`);
      }
      return {
        botUserId: (result.user_id as string) ?? "",
        team: (result.team as string) ?? "",
      };
    },
  };
}

let cachedClient: { token: string; client: SlackClient } | null = null;

/** Build (and memoize per-token) a client from config, or null if unconfigured. */
export function buildSlackClientIfConfigured(botToken: string | undefined): SlackClient | null {
  if (!botToken) return null;
  if (cachedClient?.token === botToken) return cachedClient.client;
  const client = createSlackClient({ botToken });
  cachedClient = { token: botToken, client };
  return client;
}
