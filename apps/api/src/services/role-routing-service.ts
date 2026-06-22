import { DEFAULT_ROLE_ROUTING, type RoleRoutingStrategy } from "../executors/executor-catalog";
import { readExecutorConfigFile } from "./executor-config-service";
import { KNOWN_EXECUTOR_SLOTS } from "./executor-slot-service";

export type RoleRoutingResource = {
  roleId: string;
  adapterId: string;
  strategy: RoleRoutingStrategy;
  fallbackAdapterId?: string;
  source: "default" | "file";
  allowedAdapterIds: string[];
};

export async function getRoleRoutingList(): Promise<RoleRoutingResource[]> {
  const config = await readExecutorConfigFile();
  const roles = Object.keys(DEFAULT_ROLE_ROUTING) as Array<keyof typeof DEFAULT_ROLE_ROUTING>;

  return roles.map((roleId) => {
    const fileRoute = config.roleRouting[roleId];
    const route = fileRoute ?? DEFAULT_ROLE_ROUTING[roleId];
    const allowedAdapterIds = KNOWN_EXECUTOR_SLOTS
      .filter((slot) => slot.roleTargets.some((targetRoleId) => targetRoleId === roleId))
      .map((slot) => slot.adapterId);

    return {
      roleId,
      adapterId: route.adapterId,
      strategy: route.strategy ?? "agent_only",
      ...("fallbackAdapterId" in route && route.fallbackAdapterId
        ? { fallbackAdapterId: route.fallbackAdapterId }
        : {}),
      source: fileRoute ? "file" : "default",
      allowedAdapterIds,
    };
  });
}
