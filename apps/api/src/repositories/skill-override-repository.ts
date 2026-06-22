/**
 * Per-instance overrides for Magister-bundled skills.
 *
 * The bundled `magister-*` skills ship as defaults in the repo
 * (`packages/builtin-skills/<name>/SKILL.md`). A row in `skill_overrides`
 * lets a specific role shadow the description and/or body without
 * touching the repo file. Resolution order at runtime:
 *
 *   1. Override row exists with `content_override` set     → use that body
 *   2. Override row exists with `description_override` set → use that desc
 *   3. Otherwise → fall back to the bundled file
 *
 * Description and content overrides are independent fields — a user
 * commonly wants to tweak the firing condition (description) while
 * keeping the body, or vice versa.
 *
 * `roleId` is the only tenant key today. When per-user Magister instances
 * land (B-track / multi-tenant), add `userId` to the primary key and
 * thread it through `getOverride` / `setOverride` callers.
 */

import { createDb, skillOverrides } from "@magister/db";
import { and, eq } from "@magister/db";

export type SkillOverride = {
  roleId: string;
  skillName: string;
  descriptionOverride: string | null;
  contentOverride: string | null;
  updatedAt: Date;
};

export async function getSkillOverride(
  roleId: string,
  skillName: string,
): Promise<SkillOverride | null> {
  const db = createDb();
  const row = await db.query.skillOverrides.findFirst({
    where: and(eq(skillOverrides.roleId, roleId), eq(skillOverrides.skillName, skillName)),
  });
  if (!row) return null;
  return {
    roleId: row.roleId,
    skillName: row.skillName,
    descriptionOverride: row.descriptionOverride ?? null,
    contentOverride: row.contentOverride ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Map of skill-name -> override for fast bulk lookup. Used by
 *  `listBundledSkills(role)` so the Skills tab can render the
 *  effective description for every bundled row in a single query. */
export async function getSkillOverridesForRole(
  roleId: string,
): Promise<Map<string, SkillOverride>> {
  const db = createDb();
  const rows = await db.query.skillOverrides.findMany({
    where: eq(skillOverrides.roleId, roleId),
  });
  const map = new Map<string, SkillOverride>();
  for (const row of rows) {
    map.set(row.skillName, {
      roleId: row.roleId,
      skillName: row.skillName,
      descriptionOverride: row.descriptionOverride ?? null,
      contentOverride: row.contentOverride ?? null,
      updatedAt: row.updatedAt,
    });
  }
  return map;
}

/**
 * Upsert an override. Either field may be null/undefined — passing
 * null clears just that side of the override while keeping any
 * pre-existing setting for the other. Pass empty string to commit
 * an explicitly-empty override (which the resolver will then
 * surface as "use empty string", not fallthrough).
 */
export async function setSkillOverride(
  roleId: string,
  skillName: string,
  patch: { descriptionOverride?: string | null; contentOverride?: string | null },
): Promise<SkillOverride> {
  const db = createDb();
  const now = new Date();
  const existing = await getSkillOverride(roleId, skillName);

  const description = patch.descriptionOverride !== undefined
    ? patch.descriptionOverride
    : existing?.descriptionOverride ?? null;
  const content = patch.contentOverride !== undefined
    ? patch.contentOverride
    : existing?.contentOverride ?? null;

  await db
    .insert(skillOverrides)
    .values({
      roleId,
      skillName,
      descriptionOverride: description,
      contentOverride: content,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [skillOverrides.roleId, skillOverrides.skillName],
      set: {
        descriptionOverride: description,
        contentOverride: content,
        updatedAt: now,
      },
    });

  return {
    roleId,
    skillName,
    descriptionOverride: description,
    contentOverride: content,
    updatedAt: now,
  };
}

/** Drop the override row entirely. Subsequent reads return null
 *  and the resolver falls back to the bundled file. Used by the
 *  "Reset to default" button. */
export async function clearSkillOverride(
  roleId: string,
  skillName: string,
): Promise<void> {
  const db = createDb();
  await db
    .delete(skillOverrides)
    .where(and(eq(skillOverrides.roleId, roleId), eq(skillOverrides.skillName, skillName)));
}
