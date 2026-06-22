/**
 * Plan-mode sentinel tokens. Frontend buttons post these via
 * `sendTaskMessage`; the leader loop's callModel preflight detects
 * them and emits the corresponding `leader.plan_mode_exited` event.
 *
 * Must stay in lockstep with
 * `apps/api/src/services/manager-automation/autonomous-loop/plan-mode-state.ts`.
 *
 * Spec: `docs/specs/2026-04-26-plan-mode-spec.md` §6.
 */

export const PLAN_TOKEN_APPROVED = "__PLAN_APPROVED__";
export const PLAN_TOKEN_CANCELLED = "__PLAN_CANCELLED__";
export const PLAN_TOKEN_REVISED_PREFIX = "__PLAN_REVISED__:";
