import type { SkillItem } from "./composer";

export type SkillStatusFilter = "active" | "archived" | "all";
type Filters = { query: string; scope: string; source: string; status: SkillStatusFilter };
type SkillGroup = { name: string; skills: SkillItem[] };

const SCOPE_ORDER = ["personal", "channel", "group", "team", "org"];
const scopeRank = (skill: SkillItem) => (SCOPE_ORDER.indexOf(skill.scope) + 100) % 100;

export function isArchivedSkill(skill: SkillItem): boolean {
  return skill.status === "archived";
}

export function filterSkills(skills: readonly SkillItem[], filters: Filters): SkillItem[] {
  const query = filters.query.trim().toLowerCase();
  return skills.filter((skill) => {
    if (filters.status !== "all" && (isArchivedSkill(skill) ? "archived" : "active") !== filters.status) return false;
    if (filters.scope !== "all" && skill.scope !== filters.scope) return false;
    if (filters.source === "overrides" ? !skill.shadowed : filters.source !== "all" && skill.source !== filters.source)
      return false;
    return [skill.name, skill.description, skill.scope, skill.scopeId, skill.pack?.upstreamName]
      .filter(Boolean)
      .join(" ")
      .toLowerCase()
      .includes(query);
  });
}

export function groupSkills(skills: readonly SkillItem[]): SkillGroup[] {
  const groups = new Map<string, SkillItem[]>();
  for (const skill of skills) groups.set(skill.name, [...(groups.get(skill.name) ?? []), skill]);
  return [...groups.values()]
    .map((variants) => ({
      name: variants[0]!.name,
      skills: variants.sort(
        (a, b) => Number(isArchivedSkill(a)) - Number(isArchivedSkill(b)) || scopeRank(a) - scopeRank(b),
      ),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function filterSkillGroups(groups: readonly SkillGroup[], filters: Filters): SkillGroup[] {
  return groups.flatMap((group) => {
    const overrides = filters.source === "overrides";
    if (overrides && group.skills.filter((skill) => !isArchivedSkill(skill)).length < 2) return [];
    const skills = filterSkills(group.skills, overrides ? { ...filters, source: "all" } : filters);
    return skills.length ? [{ ...group, skills }] : [];
  });
}

export function skillEmptyState(total: number, visible: number, loading: boolean) {
  if (loading && total === 0) return "loading";
  if (visible > 0) return "none";
  return total > 0 ? "filtered" : "empty";
}

export function statusCounts(skills: readonly SkillItem[]): { active: number; archived: number; all: number } {
  const archived = skills.filter(isArchivedSkill).length;
  return { active: skills.length - archived, archived, all: skills.length };
}
