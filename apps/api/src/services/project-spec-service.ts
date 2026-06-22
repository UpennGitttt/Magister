import { createDb, projectSpecs } from "@magister/db";
import { eq } from "@magister/db";

export type FeatureStatus = "pending" | "in_progress" | "implemented" | "verified" | "failed";
export type Feature = {
  id: string;
  title: string;
  description?: string;
  criteria: string[];
  status: FeatureStatus;
  assignedTo?: string;
  result?: string;
};

export type OrchestrationState = {
  spawnedRuns?: Array<{
    role: string;
    goalHash: string;
    isolate: boolean;
    status: string;
  }>;
  baselineTests?: {
    count: number;
    allGreen: boolean;
    timestamp: string;
  };
  reviewFindings?: Array<{
    id: string;
    severity: "MUST-FIX" | "NICE-TO-HAVE";
    confidence: number;
    fileLine: string;
  }>;
  verificationEvidence?: {
    command: string;
    output: string;
    passed: boolean;
  };
};

export type ProjectSpec = {
  projectName: string;
  description?: string;
  features: Feature[];
  createdAt: string;
  updatedAt: string;
  orchestration?: OrchestrationState;
};

function isFeatureStatus(value: unknown): value is FeatureStatus {
  return value === "pending"
    || value === "in_progress"
    || value === "implemented"
    || value === "verified"
    || value === "failed";
}

function statusIcon(status: FeatureStatus): string {
  switch (status) {
    case "pending":
      return "⏳";
    case "in_progress":
      return "🔄";
    case "implemented":
      return "🛠️";
    case "verified":
      return "✅";
    case "failed":
      return "❌";
    default:
      return "•";
  }
}

export async function createProjectSpec(taskId: string, spec: ProjectSpec): Promise<void> {
  const db = createDb();
  const now = Date.now();
  const { orchestration, ...specWithoutOrchestration } = spec;
  await db
    .insert(projectSpecs)
    .values({
      taskId,
      specJson: JSON.stringify(specWithoutOrchestration),
      orchestrationJson: orchestration ? JSON.stringify(orchestration) : null,
      createdAt: new Date(now),
      updatedAt: new Date(now),
    })
    .onConflictDoUpdate({
      target: projectSpecs.taskId,
      set: {
        specJson: JSON.stringify(specWithoutOrchestration),
        orchestrationJson: orchestration ? JSON.stringify(orchestration) : null,
        updatedAt: new Date(now),
      },
    });
}

export async function getProjectSpec(taskId: string): Promise<ProjectSpec | null> {
  const db = createDb();
  const row = await db.query.projectSpecs.findFirst({
    where: eq(projectSpecs.taskId, taskId),
  });
  if (!row) return null;

  try {
    const spec = JSON.parse(row.specJson) as ProjectSpec;
    if (row.orchestrationJson) {
      spec.orchestration = JSON.parse(row.orchestrationJson) as OrchestrationState;
    }
    return spec;
  } catch {
    return null;
  }
}

export async function updateProjectSpecOrchestration(
  taskId: string,
  orchestration: OrchestrationState,
): Promise<{ error?: string }> {
  const db = createDb();
  const row = await db.query.projectSpecs.findFirst({
    where: eq(projectSpecs.taskId, taskId),
  });
  if (!row) {
    return { error: `No project spec found for task ${taskId}` };
  }

  await db
    .update(projectSpecs)
    .set({
      orchestrationJson: JSON.stringify(orchestration),
      updatedAt: new Date(),
    })
    .where(eq(projectSpecs.taskId, taskId));

  return {};
}

export async function updateProjectSpec(
  taskId: string,
  spec: ProjectSpec,
): Promise<{ error?: string }> {
  const db = createDb();
  const row = await db.query.projectSpecs.findFirst({
    where: eq(projectSpecs.taskId, taskId),
  });
  if (!row) {
    return { error: `No project spec found for task ${taskId}` };
  }

  const { orchestration, ...specWithoutOrchestration } = spec;
  await db
    .update(projectSpecs)
    .set({
      specJson: JSON.stringify(specWithoutOrchestration),
      orchestrationJson: orchestration ? JSON.stringify(orchestration) : null,
      updatedAt: new Date(),
    })
    .where(eq(projectSpecs.taskId, taskId));

  return {};
}

export function parseProjectSpec(raw: string): ProjectSpec | null {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }

    const data = parsed as Record<string, unknown>;
    if (typeof data.projectName !== "string" || data.projectName.trim().length === 0) {
      return null;
    }
    if (!Array.isArray(data.features)) {
      return null;
    }

    const normalizedFeatures: Feature[] = [];
    for (const rawFeature of data.features) {
      if (!rawFeature || typeof rawFeature !== "object" || Array.isArray(rawFeature)) {
        return null;
      }
      const feature = rawFeature as Record<string, unknown>;
      if (typeof feature.id !== "string" || feature.id.trim().length === 0) {
        return null;
      }
      if (typeof feature.title !== "string" || feature.title.trim().length === 0) {
        return null;
      }
      if (!Array.isArray(feature.criteria) || !feature.criteria.every((item) => typeof item === "string")) {
        return null;
      }
      const featureStatus = isFeatureStatus(feature.status) ? feature.status : "pending";

      normalizedFeatures.push({
        id: feature.id,
        title: feature.title,
        ...(typeof feature.description === "string" ? { description: feature.description } : {}),
        criteria: feature.criteria,
        status: featureStatus,
        ...(typeof feature.assignedTo === "string" ? { assignedTo: feature.assignedTo } : {}),
        ...(typeof feature.result === "string" ? { result: feature.result } : {}),
      });
    }

    const nowIso = new Date().toISOString();
    return {
      projectName: data.projectName,
      ...(typeof data.description === "string" ? { description: data.description } : {}),
      features: normalizedFeatures,
      createdAt: typeof data.createdAt === "string" ? data.createdAt : nowIso,
      updatedAt: typeof data.updatedAt === "string" ? data.updatedAt : nowIso,
    };
  } catch {
    return null;
  }
}

export function getNextPendingFeature(spec: ProjectSpec): Feature | null {
  return spec.features.find((feature) => feature.status === "pending") ?? null;
}

export function updateFeatureStatus(
  spec: ProjectSpec,
  featureId: string,
  status: FeatureStatus,
  result?: string,
): void {
  const feature = spec.features.find((item) => item.id === featureId);
  if (!feature) {
    return;
  }

  feature.status = status;
  if (result !== undefined) {
    feature.result = result;
  }
  spec.updatedAt = new Date().toISOString();
}

export function isProjectComplete(spec: ProjectSpec): boolean {
  return spec.features.every(
    (feature) => feature.status === "verified" || feature.status === "implemented",
  );
}

export function formatSpecForPrompt(spec: ProjectSpec): string {
  const lines: string[] = [
    `Project: ${spec.projectName}`,
    ...(spec.description ? [`Description: ${spec.description}`] : []),
    `Created: ${spec.createdAt}`,
    `Updated: ${spec.updatedAt}`,
    "Features:",
  ];

  for (const feature of spec.features) {
    lines.push(`${statusIcon(feature.status)} [${feature.id}] ${feature.title}`);
    if (feature.description) {
      lines.push(`  Description: ${feature.description}`);
    }
    if (feature.assignedTo) {
      lines.push(`  Assigned To: ${feature.assignedTo}`);
    }
    for (const criterion of feature.criteria) {
      lines.push(`  - ${criterion}`);
    }
    if (feature.result) {
      lines.push(`  Result: ${feature.result}`);
    }
  }

  return lines.join("\n");
}
