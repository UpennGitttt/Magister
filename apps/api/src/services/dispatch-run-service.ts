import { ArtifactRepository } from "../repositories/artifact-repository";
import { LocalObservabilityAdapter } from "../observability/local-observability-adapter";
import { RoleRuntimeRepository } from "../repositories/role-runtime-repository";
import { TaskRepository } from "../repositories/task-repository";
import {
  createExecutorAdapter,
} from "../executors/executor-registry";
import { getRoleRoutingList } from "./role-routing-service";
import { getExecutorSlotList } from "./executor-slot-service";
import {
  readExecutorConfigFile,
} from "./executor-config-service";
import {
  getExecutorCircuitState,
  recordExecutorCircuitFailure,
  recordExecutorCircuitSuccess,
} from "./executor-circuit-breaker-service";
import { queueFeishuRuntimeTraceIfEnabled } from "./queue-feishu-runtime-trace-service";
import { mapModels, mapProviders } from "./dispatch-run/config-mapping";
import {
  buildConfigurationBlockMessage,
  buildDispatchFailure,
  buildRuntimeDispatchBlock,
  classifyConfigurationBlockCode,
  classifyDispatchFailure,
  shouldRerouteAfterDispatchFailure,
  type DispatchFailureDisposition,
  type DispatchRunFailure,
} from "./dispatch-run/failure-mapping";
import {
  resolveDispatchTargets,
  toDispatchSlot,
} from "./dispatch-run/route-selection";
import {
  adapterSupportsNativeResume,
  getExecutorCapabilities,
} from "./executor-capability-service";
import { shouldUseConversationalShortcutTask } from "./conversation-shortcut-service";
import { resolveRuntimeContinuityDecision } from "./runtime-continuity-service";
import { prepareRuntimeWorkspace, type RuntimeWorkspaceLease } from "./runtime-workspace-service";

type DispatchRunSuccess = {
  ok: true;
  runId: string;
  adapterId: string;
  state: string;
  sessionId: string;
  artifactId: string;
};

export type DispatchRunResult = DispatchRunSuccess | DispatchRunFailure;

type RunLifecycleEventType =
  | "run.claimed"
  | "runtime_workspace.allocated"
  | "run.started"
  | "run.message"
  | "run.progressed"
  | "run.completed"
  | "run.failed"
  | "run.blocked";

type ResumeDispatchDecision =
  | {
      attempted: false;
    }
  | {
      attempted: true;
      policy: "resume_first" | "rehydrate_only";
      priorSessionId: string;
      priorWorkdir: string | null;
      adapterSupportsResume: boolean;
      nativeResumeAttempted: boolean;
      fallbackToFresh: true;
      failureReason: string | null;
    }
  | {
      attempted: true;
      policy: "rehydrate_only";
      priorSessionId: string;
      priorWorkdir: string | null;
      adapterSupportsResume: false;
      nativeResumeAttempted: false;
      fallbackToFresh: false;
      failureReason: "rehydrate_only";
    };

function resolveResumeDispatchDecision(input: {
  runtime: NonNullable<Awaited<ReturnType<RoleRuntimeRepository["getById"]>>>;
  adapterId: string;
}): ResumeDispatchDecision {
  const policy = input.runtime.resumePolicy;
  const priorSessionId = input.runtime.priorSessionId?.trim();
  if ((policy !== "resume_first" && policy !== "rehydrate_only") || !priorSessionId) {
    return {
      attempted: false,
    };
  }

  const adapterSupportsResume = adapterSupportsNativeResume(input.adapterId);

  if (policy === "rehydrate_only") {
    return {
      attempted: true,
      policy: "rehydrate_only",
      priorSessionId,
      priorWorkdir: input.runtime.priorWorkdir?.trim() ?? null,
      adapterSupportsResume: false,
      nativeResumeAttempted: false,
      fallbackToFresh: false,
      failureReason: "rehydrate_only",
    };
  }

  return {
    attempted: true,
    policy: "resume_first",
    priorSessionId,
    priorWorkdir: input.runtime.priorWorkdir?.trim() ?? null,
    adapterSupportsResume,
    nativeResumeAttempted: adapterSupportsResume,
    fallbackToFresh: true,
    failureReason: adapterSupportsResume ? null : `resume_not_supported_for_${input.adapterId}`,
  };
}

async function recordRunLifecycleEvent(
  observabilityAdapter: LocalObservabilityAdapter,
  input: {
    type: RunLifecycleEventType;
    taskId: string;
    roleRuntimeId: string;
    workspaceId: string;
    occurredAt: Date;
    severity: "info" | "warning" | "error";
    payload: Record<string, unknown>;
  },
) {
  await observabilityAdapter.recordEvent({
    id: `event_${crypto.randomUUID()}`,
    type: input.type,
    taskId: input.taskId,
    roleRuntimeId: input.roleRuntimeId,
    workspaceId: input.workspaceId,
    severity: input.severity,
    occurredAt: input.occurredAt,
    payloadJson: JSON.stringify(input.payload),
  });
}

export async function dispatchRun(
  runId: string,
): Promise<DispatchRunResult | null> {
  const observabilityAdapter = new LocalObservabilityAdapter();
  const roleRuntimeRepository = new RoleRuntimeRepository();
  const taskRepository = new TaskRepository();
  const artifactRepository = new ArtifactRepository();
  const config = await readExecutorConfigFile();

  const runtime = await roleRuntimeRepository.getById(runId);
  if (!runtime) {
    return null;
  }

  const task = await taskRepository.getById(runtime.taskId);
  if (!task) {
    return null;
  }

  const roleRouting = await getRoleRoutingList();
  const selectedRouting = roleRouting.find((item) => item.roleId === runtime.roleId) ?? null;
  // Leader MUST run on Magister's internal loop, not on any CLI
  // adapter. Refuse explicitly with an actionable message so the
  // failure mode is loud, not
  // mysterious. The legacy "manager" roleId is normalized to
  // "leader" in the role-routing-service alias path, but defend
  // here too in case raw DB rows from old installs survive.
  // Refusal targets the original bug: leader/manager runtime with
  // NO routing config → `?? "codex"` fallback below → codex CLI
  // preflight refuses (no model) → BLOCKED but mysterious. The
  // narrow check: only refuse when routing is missing for the
  // orchestration role; an operator who explicitly routes leader
  // to a specific adapter (binding can be API or CLI) is honored.
  // This handles the recovery-of-stale-leader-runtime case from
  // the original report without breaking dispatch tests that
  // legitimately exercise CLI adapter routing for leader bindings.
  if (
    (runtime.roleId === "leader" || runtime.roleId === "manager")
    && !selectedRouting
  ) {
    {
      const blockedAt = new Date();
      const message =
        `Role "${runtime.roleId}" has no routing configured. The orchestration `
        + `role must NOT fall back to the codex CLI adapter — that would run `
        + `the leader as an external CLI agent. Add a leader entry to `
        + `config/executors.json roleRouting pointing at a model binding.`;
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.blocked",
        taskId: task.id,
        roleRuntimeId: runtime.id,
        workspaceId: task.workspaceId,
        occurredAt: blockedAt,
        severity: "warning",
        payload: {
          message,
          reason: "executor_unconfigured",
          source: null,
          failureClass: "configuration",
          retryability: false,
          nextAction: "manual_fix",
        },
      });
      return {
        ok: false,
        runId: runtime.id,
        adapterId: "(none)",
        state: runtime.state,
        code: "executor_unconfigured",
        message,
        failureClass: "configuration",
        retryability: false,
        nextAction: "manual_fix",
      };
    }
  }
  const adapterId = selectedRouting?.adapterId ?? "codex";
  // Codex review Q1 — initially had a catalog-based secondary
  // guard here that refused leader on any `coding_agent`
  // executorType. Backed out: legitimate test/prod scenarios use
  // an adapter with catalog type=coding_agent (e.g. `opencode`)
  // bound to executionMode="api" — the binding's mode is what
  // actually matters at runtime, not the catalog adapter type.
  // The narrow `!selectedRouting` refusal above is sufficient to
  // close the original recovery-path bug. If an operator
  // explicitly routes leader to a CLI adapter and the binding
  // really is CLI-mode, the codex preflight at downstream
  // `buildRuntimeDispatchBlock` will still surface the misconfig
  // (no configuredModel for codex) as before.
  const earlyRuntimeDispatchBlock = buildRuntimeDispatchBlock(runtime, adapterId);
  if (earlyRuntimeDispatchBlock) {
    const blockedAt = new Date();
    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.blocked",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      occurredAt: blockedAt,
      severity: "warning",
      payload: {
        message: earlyRuntimeDispatchBlock.message,
        reason: earlyRuntimeDispatchBlock.code,
        source: earlyRuntimeDispatchBlock.adapterId,
        failureClass: earlyRuntimeDispatchBlock.failureClass,
        retryability: earlyRuntimeDispatchBlock.retryability,
        nextAction: earlyRuntimeDispatchBlock.nextAction,
      },
    });
    return earlyRuntimeDispatchBlock;
  }
  await recordRunLifecycleEvent(observabilityAdapter, {
    type: "run.claimed",
    taskId: task.id,
    roleRuntimeId: runtime.id,
    workspaceId: task.workspaceId,
    occurredAt: new Date(),
    severity: "info",
    payload: {
      message: `Run ${runtime.id} claimed for dispatch`,
      roleId: runtime.roleId,
      taskId: task.id,
      workspaceId: task.workspaceId,
      source: adapterId,
    },
  });
  const resumeDecision = resolveResumeDispatchDecision({
    runtime,
    adapterId,
  });
  if (resumeDecision.attempted) {
    const resumeAttemptedAt = new Date();
    const continuityDecision = resolveRuntimeContinuityDecision({
      adapterId,
      priorSessionId: resumeDecision.priorSessionId,
      priorWorkdir: resumeDecision.priorWorkdir,
      resumePolicy: resumeDecision.policy,
      nativeResumeAttempted: resumeDecision.nativeResumeAttempted,
      resumeFailureReason: resumeDecision.failureReason,
    });
    await roleRuntimeRepository.update(runtime.id, {
      resumeAttemptedAt: resumeDecision.nativeResumeAttempted ? resumeAttemptedAt : null,
      resumeFailureReason: resumeDecision.failureReason,
      updatedAt: resumeAttemptedAt,
    });
    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.message",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      occurredAt: resumeAttemptedAt,
      severity: "info",
      payload: {
        message:
          resumeDecision.policy === "rehydrate_only"
            ? `Rehydration-only continuity armed from ${resumeDecision.priorSessionId}; adapter ${adapterId} will start fresh using control-plane context artifacts`
            : resumeDecision.adapterSupportsResume
              ? `Resume-first policy armed from ${resumeDecision.priorSessionId}; adapter will attempt resume before fresh fallback`
              : `Resume-first policy requested from ${resumeDecision.priorSessionId} but adapter ${adapterId} does not support resume, so dispatch will start fresh`,
        reason: resumeDecision.failureReason ?? "resume_requested",
        source: adapterId,
        policy: resumeDecision.policy,
        priorSessionId: resumeDecision.priorSessionId,
        priorWorkdir: resumeDecision.priorWorkdir,
        adapterSupportsResume: resumeDecision.adapterSupportsResume,
        nativeResumeAttempted: resumeDecision.nativeResumeAttempted,
        fallbackToFresh: resumeDecision.fallbackToFresh,
        continuity: continuityDecision,
      },
    });
  }
  const executorSlots = await getExecutorSlotList();
  const dispatchTargets = resolveDispatchTargets({
    adapterId,
    roleId: runtime.roleId,
    config,
    executorSlots,
    ...(selectedRouting?.strategy ? { strategy: selectedRouting.strategy } : {}),
    ...(selectedRouting?.fallbackAdapterId
      ? { fallbackAdapterId: selectedRouting.fallbackAdapterId }
      : {}),
  });

  if (dispatchTargets.length === 0) {
    const blockedAt = new Date();
    const blocked = buildDispatchFailure({
      runId,
      adapterId,
      code: "executor_unconfigured",
      message: `No eligible executor remained for run ${runId}`,
    });
    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.blocked",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      occurredAt: blockedAt,
      severity: "warning",
      payload: {
        message: blocked.message,
        reason: blocked.code,
        source: blocked.adapterId,
        failureClass: blocked.failureClass,
        retryability: blocked.retryability,
        nextAction: blocked.nextAction,
      },
    });
    return blocked;
  }

  const readyTargets = dispatchTargets.filter((candidate) => candidate.readiness.ready);
  if (readyTargets.length === 0) {
    const primaryCandidate = dispatchTargets[0]!;
    const dispatchSlot = toDispatchSlot(primaryCandidate);
    const failedAt = new Date();
    const message = buildConfigurationBlockMessage(
      dispatchSlot.displayName,
      runtime.roleId,
      primaryCandidate.readiness.missing,
    );
    const code = classifyConfigurationBlockCode(primaryCandidate.readiness.missing);

    await roleRuntimeRepository.update(runtime.id, {
      state: "FAILED",
      activeExecutorId: dispatchSlot.adapterId,
      currentSessionId: null,
      delegationMode: runtime.delegationMode ?? "delegate_fresh",
      attemptCount: runtime.attemptCount + 1,
      startedAt: runtime.startedAt ?? failedAt,
      updatedAt: failedAt,
      completedAt: failedAt,
    });

    await taskRepository.update(task.id, {
      state: "BLOCKED",
      updatedAt: failedAt,
    });

    const blocked = buildDispatchFailure({
      runId: runtime.id,
      adapterId: dispatchSlot.adapterId,
      code,
      message,
    });

    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.blocked",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      severity: "warning",
      occurredAt: failedAt,
      payload: {
        message,
        error: message,
        reason: code,
        source: dispatchSlot.adapterId,
        missing: primaryCandidate.readiness.missing,
        failureClass: blocked.failureClass,
        retryability: blocked.retryability,
        nextAction: blocked.nextAction,
      },
    });

    await new LocalObservabilityAdapter().recordEvent({
      id: `event_${failedAt.getTime()}`,
      type: "executor_session.failed",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      executorSessionId: `session_${dispatchSlot.adapterId}_${runtime.id}`,
      workspaceId: task.workspaceId,
      severity: "error",
      occurredAt: failedAt,
      payloadJson: JSON.stringify({
        message,
        error: message,
        reason: code,
        source: dispatchSlot.adapterId,
        missing: primaryCandidate.readiness.missing,
        failureClass: blocked.failureClass,
        retryability: blocked.retryability,
        nextAction: blocked.nextAction,
      }),
    });

    return blocked;
  }

  const mappedProviders = mapProviders(config.providers);
  const mappedModels = mapModels(config.models);
  const attemptedAdapters: string[] = [];
  const skippedOpenCircuitAdapters: string[] = [];
  let rerouteSource:
    | {
        adapterId: string;
        failure: DispatchRunFailure;
      }
    | null = null;
  let result: DispatchRunResult | null = null;
  const shouldAllowManagerFallbackReroute = (input: {
    roleId: string;
    adapterId: string;
    code: DispatchRunFailure["code"];
  }) =>
    input.roleId === "leader" &&
    input.adapterId === "model" &&
    (input.code === "executor_auth_failed" ||
      input.code === "executor_unconfigured" ||
      input.code === "executor_provider_missing" ||
      input.code === "executor_model_missing");

  for (const target of readyTargets) {
    const dispatchSlot = toDispatchSlot(target);
    const circuitState = await getExecutorCircuitState(dispatchSlot.adapterId);
    if (circuitState.state === "open") {
      skippedOpenCircuitAdapters.push(dispatchSlot.adapterId);
      attemptedAdapters.push(dispatchSlot.adapterId);
      const progressedAt = new Date();
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.progressed",
        taskId: task.id,
        roleRuntimeId: runtime.id,
        workspaceId: task.workspaceId,
        occurredAt: progressedAt,
        severity: "info",
        payload: {
          message: `Skipped open circuit adapter ${dispatchSlot.adapterId} while dispatching run ${runId}`,
          reason: "circuit_open",
          failureClass: "transient",
          retryability: true,
          nextAction: "reroute",
          fromAdapterId: dispatchSlot.adapterId,
          skippedOpenCircuitAdapters: [...skippedOpenCircuitAdapters],
          attemptedAdapters: [...attemptedAdapters],
        },
      });
      continue;
    }

    const latestRuntime = await roleRuntimeRepository.getById(runId);
    if (!latestRuntime) {
      return null;
    }
    const latestTask = await taskRepository.getById(latestRuntime.taskId);
    if (!latestTask) {
      return null;
    }

    const runtimeDispatchBlock = buildRuntimeDispatchBlock(latestRuntime, dispatchSlot.adapterId);
    if (runtimeDispatchBlock) {
      return runtimeDispatchBlock;
    }

    if (skippedOpenCircuitAdapters.length > 0) {
      const fromAdapterId = skippedOpenCircuitAdapters[0]!;
      const progressedAt = new Date();
      await taskRepository.update(latestTask.id, {
        state: "IN_PROGRESS",
        updatedAt: new Date(),
      });
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.progressed",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        severity: "info",
        occurredAt: progressedAt,
        payload: {
          message: `Dispatch rerouted from ${fromAdapterId} to ${dispatchSlot.adapterId} because the primary circuit is open`,
          reason: "reroute_circuit_open",
          failureClass: "transient",
          retryability: true,
          nextAction: "reroute",
          fromAdapterId,
          toAdapterId: dispatchSlot.adapterId,
          routeSource: target.routeSource,
          attemptedAdapters,
          skippedOpenCircuitAdapters: [...skippedOpenCircuitAdapters],
        },
      });
      await observabilityAdapter.recordEvent({
        id: `event_${crypto.randomUUID()}`,
        type: "task.orchestration.transition",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        severity: "info",
        occurredAt: new Date(),
        payloadJson: JSON.stringify({
          message: `Dispatch rerouted from ${fromAdapterId} to ${dispatchSlot.adapterId} because the primary circuit is open`,
          transition: "retry",
          reason: "reroute_circuit_open",
          action: "dispatch",
          state: "IN_PROGRESS",
          taskState: "IN_PROGRESS",
          roleId: latestRuntime.roleId,
          fromAdapterId,
          toAdapterId: dispatchSlot.adapterId,
          routeSource: target.routeSource,
          attemptedAdapters,
          skippedOpenCircuitAdapters: [...skippedOpenCircuitAdapters],
        }),
      });
      await queueFeishuRuntimeTraceIfEnabled({
        source: latestTask.source,
        rootChannelBindingId: latestTask.rootChannelBindingId,
        workspaceId: latestTask.workspaceId,
        taskId: latestTask.id,
        sourceEventId: `run.rerouted:${latestRuntime.id}:${fromAdapterId}:${dispatchSlot.adapterId}:circuit_open`,
        eventType: "run.rerouted",
        summary: `执行器重路由：${fromAdapterId} -> ${dispatchSlot.adapterId}（circuit_open）`,
        details: {
          fromAdapterId,
          toAdapterId: dispatchSlot.adapterId,
          reason: "reroute_circuit_open",
          routeSource: target.routeSource,
          attemptedAdapters,
          skippedOpenCircuitAdapters: [...skippedOpenCircuitAdapters],
        },
        roleId: latestRuntime.roleId,
        executorId: dispatchSlot.adapterId,
        sessionId: latestRuntime.currentSessionId ?? undefined,
        attemptCount: latestRuntime.attemptCount,
      });
      skippedOpenCircuitAdapters.length = 0;
    }

    if (rerouteSource) {
      const progressedAt = new Date();
      await taskRepository.update(latestTask.id, {
        state: "IN_PROGRESS",
        updatedAt: new Date(),
      });
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.progressed",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        severity: "info",
        occurredAt: progressedAt,
        payload: {
          message: `Dispatch rerouted from ${rerouteSource.adapterId} to ${dispatchSlot.adapterId} after ${rerouteSource.failure.code}`,
          reason: `reroute_after_${rerouteSource.failure.code}`,
          failureClass: "transient",
          retryability: true,
          nextAction: "reroute",
          fromAdapterId: rerouteSource.adapterId,
          toAdapterId: dispatchSlot.adapterId,
          routeSource: target.routeSource,
          dispatchCode: rerouteSource.failure.code,
          dispatchMessage: rerouteSource.failure.message,
          attemptedAdapters,
        },
      });
      await observabilityAdapter.recordEvent({
        id: `event_${crypto.randomUUID()}`,
        type: "task.orchestration.transition",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        severity: "info",
        occurredAt: new Date(),
        payloadJson: JSON.stringify({
          message: `Dispatch rerouted from ${rerouteSource.adapterId} to ${dispatchSlot.adapterId} after ${rerouteSource.failure.code}`,
          transition: "retry",
          reason: `reroute_after_${rerouteSource.failure.code}`,
          action: "dispatch",
          state: "IN_PROGRESS",
          taskState: "IN_PROGRESS",
          roleId: latestRuntime.roleId,
          fromAdapterId: rerouteSource.adapterId,
          toAdapterId: dispatchSlot.adapterId,
          routeSource: target.routeSource,
          dispatchCode: rerouteSource.failure.code,
          dispatchMessage: rerouteSource.failure.message,
          attemptedAdapters,
        }),
      });
      await queueFeishuRuntimeTraceIfEnabled({
        source: latestTask.source,
        rootChannelBindingId: latestTask.rootChannelBindingId,
        workspaceId: latestTask.workspaceId,
        taskId: latestTask.id,
        sourceEventId: `run.rerouted:${latestRuntime.id}:${rerouteSource.adapterId}:${dispatchSlot.adapterId}:${rerouteSource.failure.code}`,
        eventType: "run.rerouted",
        summary: `执行器重路由：${rerouteSource.adapterId} -> ${dispatchSlot.adapterId}（${rerouteSource.failure.code}）`,
        details: {
          fromAdapterId: rerouteSource.adapterId,
          toAdapterId: dispatchSlot.adapterId,
          reason: `reroute_after_${rerouteSource.failure.code}`,
          dispatchCode: rerouteSource.failure.code,
          dispatchMessage: rerouteSource.failure.message,
          routeSource: target.routeSource,
          attemptedAdapters,
        },
        roleId: latestRuntime.roleId,
        executorId: dispatchSlot.adapterId,
        sessionId: latestRuntime.currentSessionId ?? undefined,
        attemptCount: latestRuntime.attemptCount,
      });
    }

    attemptedAdapters.push(dispatchSlot.adapterId);
    const executorCapabilities = getExecutorCapabilities(dispatchSlot.adapterId);
    const shouldSkipDefaultManagerWorkspace =
      latestRuntime.roleId === "leader" &&
      shouldUseConversationalShortcutTask(
        {
          title: latestTask.title,
          description: latestTask.description ?? null,
        },
        { policy: "broad" },
      );
    const runtimeWorkspaceLease: RuntimeWorkspaceLease | null =
      executorCapabilities.runtimeWorkspace && !shouldSkipDefaultManagerWorkspace
      ? await prepareRuntimeWorkspace({
          runId: latestRuntime.id,
          taskId: latestTask.id,
          roleId: latestRuntime.roleId,
          workspaceId: latestTask.workspaceId,
          requestedStrategy:
            latestRuntime.workspaceStrategyOverride === "workspace_root" ||
            latestRuntime.workspaceStrategyOverride === "git_worktree"
              ? latestRuntime.workspaceStrategyOverride
              : null,
        })
      : null;
    if (runtimeWorkspaceLease) {
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "runtime_workspace.allocated",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        occurredAt: new Date(),
        severity: "info",
        payload: {
          message: `Allocated ${runtimeWorkspaceLease.strategy} runtime workspace for ${dispatchSlot.adapterId}`,
          adapterId: dispatchSlot.adapterId,
          routeSource: target.routeSource,
          workspaceStrategyOverride: latestRuntime.workspaceStrategyOverride ?? null,
          requestedStrategy: runtimeWorkspaceLease.requestedStrategy,
          resolvedStrategy: runtimeWorkspaceLease.strategy,
          decisionReason: runtimeWorkspaceLease.decisionReason,
          fallbackReason: runtimeWorkspaceLease.fallbackReason,
          baseWorkspaceDir: runtimeWorkspaceLease.baseWorkspaceDir,
          workspaceDir: runtimeWorkspaceLease.workspaceDir,
          metadataPath: runtimeWorkspaceLease.metadataPath,
        },
      });
    }
    const startedAt = new Date();
    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.started",
      taskId: latestTask.id,
      roleRuntimeId: latestRuntime.id,
      workspaceId: latestTask.workspaceId,
      occurredAt: startedAt,
      severity: "info",
      payload: {
        message: `Dispatch started on ${dispatchSlot.adapterId} for run ${runId}`,
        roleId: latestRuntime.roleId,
        adapterId: dispatchSlot.adapterId,
        routeSource: target.routeSource,
        attemptCount: attemptedAdapters.length,
        runtimeWorkspace: runtimeWorkspaceLease
          ? {
              requestedStrategy: runtimeWorkspaceLease.requestedStrategy,
              resolvedStrategy: runtimeWorkspaceLease.strategy,
              decisionReason: runtimeWorkspaceLease.decisionReason,
              fallbackReason: runtimeWorkspaceLease.fallbackReason,
              workspaceDir: runtimeWorkspaceLease.workspaceDir,
              baseWorkspaceDir: runtimeWorkspaceLease.baseWorkspaceDir,
            }
          : null,
      },
    });
    const dispatchResult = await createExecutorAdapter(dispatchSlot, {
      providers: mappedProviders,
      models: mappedModels,
    }).execute({
      runtime: latestRuntime,
      task: latestTask,
      slot: dispatchSlot,
      runtimeWorkspace: runtimeWorkspaceLease,
      dependencies: {
        roleRuntimeRepository,
        taskRepository,
        artifactRepository,
        observabilityAdapter,
      },
    });

    const normalizedDispatchResult: DispatchRunResult = dispatchResult.ok
      ? dispatchResult
      : {
          ...dispatchResult,
          ...classifyDispatchFailure(dispatchResult.code),
        };

    result = normalizedDispatchResult;
    if (normalizedDispatchResult.ok) {
      const completedAt = new Date();
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.completed",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        occurredAt: completedAt,
        severity: "info",
        payload: {
          message: `Dispatch completed on ${dispatchSlot.adapterId} for run ${runId}`,
          roleId: latestRuntime.roleId,
          adapterId: dispatchSlot.adapterId,
          sessionId: normalizedDispatchResult.sessionId,
          artifactId: normalizedDispatchResult.artifactId,
          routeSource: target.routeSource,
        },
      });
      await recordExecutorCircuitSuccess(dispatchSlot.adapterId);
      break;
    }

    if (shouldRerouteAfterDispatchFailure(normalizedDispatchResult.code)) {
      await recordExecutorCircuitFailure(dispatchSlot.adapterId, {
        code: normalizedDispatchResult.code,
      });
    }

    const failureDisposition = classifyDispatchFailure(normalizedDispatchResult.code);
    const shouldRerouteManagerFailure = shouldAllowManagerFallbackReroute({
      roleId: latestRuntime.roleId,
      adapterId: dispatchSlot.adapterId,
      code: normalizedDispatchResult.code,
    });
    const effectiveFailureDisposition = shouldRerouteManagerFailure
      ? {
          ...failureDisposition,
          nextAction: "reroute" as const,
        }
      : failureDisposition;
    rerouteSource = {
      adapterId: dispatchSlot.adapterId,
      failure: normalizedDispatchResult,
    };

    if (
      !shouldRerouteAfterDispatchFailure(normalizedDispatchResult.code) &&
      !shouldRerouteManagerFailure
    ) {
      const blockedAt = new Date();
      await recordRunLifecycleEvent(observabilityAdapter, {
        type: "run.blocked",
        taskId: latestTask.id,
        roleRuntimeId: latestRuntime.id,
        workspaceId: latestTask.workspaceId,
        occurredAt: blockedAt,
        severity: "warning",
        payload: {
          message: normalizedDispatchResult.message,
          reason: normalizedDispatchResult.code,
          failureClass: effectiveFailureDisposition.failureClass,
          retryability: effectiveFailureDisposition.retryability,
          nextAction: effectiveFailureDisposition.nextAction,
          source: dispatchSlot.adapterId,
          routeSource: target.routeSource,
        },
      });
      break;
    }

    const progressAt = new Date();
    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.progressed",
      taskId: latestTask.id,
      roleRuntimeId: latestRuntime.id,
      workspaceId: latestTask.workspaceId,
      occurredAt: progressAt,
      severity: "info",
      payload: {
        message: `Dispatch will reroute from ${dispatchSlot.adapterId} after ${normalizedDispatchResult.code}`,
        reason: normalizedDispatchResult.code,
        failureClass: effectiveFailureDisposition.failureClass,
        retryability: effectiveFailureDisposition.retryability,
        nextAction: effectiveFailureDisposition.nextAction,
        source: dispatchSlot.adapterId,
        routeSource: target.routeSource,
        attemptedAdapters,
      },
    });

    await new Promise<void>((resolve) => {
      setTimeout(resolve, 150);
    });
  }

  if (!result) {
    const failedAt = new Date();
    const unavailableAdapterId = attemptedAdapters[0] ?? adapterId;
    const message =
      attemptedAdapters.length > 0
        ? `All eligible executors are temporarily unavailable because their circuits are open: ${attemptedAdapters.join(", ")}`
      : `No eligible executor remained for run ${runId}`;
    const failureDisposition: DispatchFailureDisposition = {
      failureClass: "transient",
      retryability: true,
      nextAction: "retry",
    };

    await roleRuntimeRepository.update(runtime.id, {
      state: "FAILED",
      activeExecutorId: unavailableAdapterId,
      currentSessionId: null,
      delegationMode: runtime.delegationMode ?? "delegate_fresh",
      attemptCount: runtime.attemptCount + 1,
      startedAt: runtime.startedAt ?? failedAt,
      updatedAt: failedAt,
      completedAt: failedAt,
    });

    await taskRepository.update(task.id, {
      state: "BLOCKED",
      updatedAt: failedAt,
    });

    await recordRunLifecycleEvent(observabilityAdapter, {
      type: "run.failed",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      workspaceId: task.workspaceId,
      severity: "error",
      occurredAt: failedAt,
      payload: {
        message,
        reason: "executor_unavailable",
        source: unavailableAdapterId,
        attemptedAdapters,
        failureClass: failureDisposition.failureClass,
        retryability: failureDisposition.retryability,
        nextAction: failureDisposition.nextAction,
      },
    });

    await observabilityAdapter.recordEvent({
      id: `event_${crypto.randomUUID()}`,
      type: "executor_session.failed",
      taskId: task.id,
      roleRuntimeId: runtime.id,
      executorSessionId: `session_${unavailableAdapterId}_${runtime.id}`,
      workspaceId: task.workspaceId,
      severity: "error",
      occurredAt: failedAt,
      payloadJson: JSON.stringify({
        message,
        error: message,
        reason: "executor_unavailable",
        source: unavailableAdapterId,
        attemptedAdapters,
        failureClass: failureDisposition.failureClass,
        retryability: failureDisposition.retryability,
        nextAction: failureDisposition.nextAction,
      }),
    });

    return {
      ok: false,
      runId,
      adapterId: unavailableAdapterId,
      state: "FAILED",
      code: "executor_unavailable",
      message,
      failureClass: failureDisposition.failureClass,
      retryability: failureDisposition.retryability,
      nextAction: failureDisposition.nextAction,
    };
  }

  return result;
}
