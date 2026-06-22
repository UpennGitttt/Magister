import { deliverQueuedFeishuOutboundEvents } from "./feishu-outbound-delivery-service";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";

type DispatchQueuedFeishuOutboundEventInput = {
  eventId: string;
  kind: string;
  taskId?: string;
  bindingId: string;
  workspaceId: string;
  failureType:
    | "channel.outbound.ack_failed"
    | "channel.outbound.delivery_failed"
    | "channel.outbound.approval_delivery_failed";
};

export async function dispatchQueuedFeishuOutboundEventBestEffort(
  input: DispatchQueuedFeishuOutboundEventInput,
) {
  const observabilityAdapter = new LocalObservabilityAdapter();

  try {
    await deliverQueuedFeishuOutboundEvents({
      eventIds: [input.eventId],
    });
  } catch (error) {
    await observabilityAdapter.recordEvent({
      id: `event_${crypto.randomUUID()}`,
      type: input.failureType,
      ...(input.taskId ? { taskId: input.taskId } : {}),
      conversationBindingId: input.bindingId,
      workspaceId: input.workspaceId,
      severity: "warn",
      occurredAt: new Date(),
      payloadJson: JSON.stringify({
        bindingId: input.bindingId,
        ...(input.taskId ? { taskId: input.taskId } : {}),
        kind: input.kind,
        error: error instanceof Error ? error.message : String(error),
      }),
    });
  }
}
