import { getFeishuWebSocketGatewayStatus } from "../integrations/feishu/feishu-websocket-gateway";
import { getArtifactRetentionStatus } from "./artifact-retention-service";
import { getRuntimeRecoveryStatus } from "./runtime-recovery-service";
import { taskWorker } from "./task-worker";

export async function getSystemStatus() {
  const [artifactRetention, runtimeRecovery] = await Promise.all([
    getArtifactRetentionStatus(),
    getRuntimeRecoveryStatus(),
  ]);

  return {
    workers: {
      artifactRetention,
      runtimeRecovery,
      // Concurrent-pool snapshot for Settings → Status display.
      taskWorker: taskWorker.snapshot(),
    },
    integrations: {
      feishuGateway: getFeishuWebSocketGatewayStatus(),
    },
  };
}
