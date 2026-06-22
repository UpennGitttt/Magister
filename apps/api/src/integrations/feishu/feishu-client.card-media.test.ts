import { describe, expect, it } from "bun:test";
import { createFeishuClient } from "./feishu-client";

function stubFetch(captured: any[], data: object) {
  return async (url: string, init: any) => {
    captured.push({ url, init });
    if (url.includes("/auth/v3/tenant_access_token")) {
      return new Response(JSON.stringify({ code: 0, tenant_access_token: "t", expire: 7200 }), { status: 200 });
    }
    return new Response(JSON.stringify({ code: 0, data }), { status: 200 });
  };
}

describe("uploadImage", () => {
  it("POSTs multipart to im/v1/images and returns image_key", async () => {
    const captured: any[] = [];
    const client = createFeishuClient({ appId: "a", appSecret: "s", fetchImpl: stubFetch(captured, { image_key: "img_abc" }) as any });
    const res = await client.uploadImage({ data: Buffer.from([0x89, 0x50, 0x4e, 0x47]), filename: "x.png" });
    expect(res.imageKey).toBe("img_abc");
    const call = captured.find((c) => c.url.includes("/open-apis/im/v1/images"));
    expect(call).toBeTruthy();
    expect(call.init.method).toBe("POST");
    expect(call.init.body instanceof FormData).toBe(true);
    expect(call.init.body.get("image_type")).toBe("message");
  });
});

describe("updateCard", () => {
  it("PUTs full card to /cardkit/v1/cards/{cardId} with confirmed body shape: card as object {type,data} where data is stringified JSON", async () => {
    const captured: any[] = [];
    const client = createFeishuClient({ appId: "a", appSecret: "s", fetchImpl: stubFetch(captured, {}) as any });
    const cardJson = { schema: "2.0", config: { streaming_mode: false }, body: { elements: [] } };
    await client.updateCard({ cardId: "c1", cardJson, sequence: 9, uuid: "u9" });
    const call = captured.find((c) => c.url.includes("/open-apis/cardkit/v1/cards/c1"));
    expect(call).toBeTruthy();
    expect(call.init.method).toBe("PUT");
    const body = JSON.parse(call.init.body as string);
    expect(body.sequence).toBe(9);
    expect(body.uuid).toBe("u9");
    // Spike confirmed (code:0 live): card is an object { type: "card_json", data: <stringified JSON> }
    expect(typeof body.card).toBe("object");
    expect(body.card.type).toBe("card_json");
    expect(typeof body.card.data).toBe("string");
    // data must deserialize back to the original cardJson
    expect(JSON.parse(body.card.data as string)).toEqual(cardJson);
  });
});
