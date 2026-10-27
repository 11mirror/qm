import { randomUUID } from "node:crypto";
import type { AdvisoryLock } from "../persistence/advisory-lock.ts";
import { createPgPool, tenantCols } from "../persistence/pg-pool.ts";
import { cols, mapToTableMigration, tableCodec, type TableSpec } from "../persistence/typed-table.ts";
import { scopeId, type ScopeId } from "../types.ts";
import { samePerson } from "../directory/person.ts";
import { createKeyedQueue } from "../util/async.ts";
import { tenant } from "../tenant.ts";

const PROJECT_GROUP_PREFIX = "web-project-";

interface ProjectSlackChannel {
  channelId: string;
  channelName: string;
  linkedBy: string;
  linkedAt: number;
}

export interface Project {
  id: string;
  orgId: string;
  name: string;
  ownerId: string;
  memberIds: string[];
  channelMemberIds?: string[];
  slackChannel?: ProjectSlackChannel;
  createdAt: number;
  updatedAt: number;
}

type ProjectMutation =
  | { status: "ok"; project: Project; changed: boolean }
  | { status: "not_found" | "forbidden" | "invalid_member" | "invalid_name" };

type ProjectMutationEffect = (result: Extract<ProjectMutation, { status: "ok" }>) => Promise<void>;

export interface ProjectStore {
  create(input: { name: string; ownerId: string }): Promise<Project>;
  get(id: string): Promise<Project | null>;
  listForMember(principalId: string): Promise<Project[]>;
  addMember(id: string, actorId: string, memberId: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  removeMember(id: string, actorId: string, memberId: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  rename(id: string, ownerId: string, name: string, effect?: ProjectMutationEffect): Promise<ProjectMutation>;
  setSlackChannel(
    id: string,
    actorId: string,
    link: { channelId: string; channelName: string } | null,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation>;
  syncChannelMembers(
    id: string,
    memberIds: readonly string[],
    channelName?: string,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation>;
  listLinked(): Promise<Project[]>;
  slackChannel(groupRef: string): Promise<ProjectSlackChannel | undefined>;
  recognizes(groupRef: string): boolean;
  membership(groupRef: string, principalId: string): Promise<boolean | undefined>;
  members(groupRef: string): Promise<string[] | undefined>;
  version(groupRef: string): Promise<string | undefined>;
  withVersion<T>(groupRef: string, version: string | undefined, fn: () => Promise<T>): Promise<T | undefined>;
  name(groupRef: string): Promise<string | undefined>;
  withRosterLock<T>(id: string, fn: (project: Project) => Promise<T>): Promise<T | null>;
}

export function projectGroupRef(id: string): string {
  return `${PROJECT_GROUP_PREFIX}${id}`;
}

export function projectScopeId(id: string): ScopeId {
  return scopeId("group", projectGroupRef(id));
}

export function projectIdFromGroupRef(ref: string): string | null {
  if (!isProjectGroupRef(ref)) return null;
  const id = ref.slice(PROJECT_GROUP_PREFIX.length);
  return id && !id.includes(":") ? id : null;
}

export function isProjectGroupRef(ref: string): boolean {
  return ref.startsWith(PROJECT_GROUP_PREFIX);
}

function cleanName(name: string): string {
  return name.trim().replace(/\s+/g, " ").slice(0, 200);
}

function visible(project: Project): Project {
  return {
    ...project,
    memberIds: [...project.memberIds],
    ...(project.channelMemberIds ? { channelMemberIds: [...project.channelMemberIds] } : {}),
    ...(project.slackChannel ? { slackChannel: { ...project.slackChannel } } : {}),
  };
}

const PROJECTS: TableSpec = {
  table: "projects",
  key: "id",
  keyIsField: true,
  columns: cols(`orgId text!, name text!, ownerId text!, memberIds text[]!, channelMemberIds text[],
    slackChannel jsonb, createdAt bigint!, updatedAt bigint!`),
};

export const PROJECTS_MIGRATION = mapToTableMigration("projects/store/0001-typed", PROJECTS, {
  statements: [`CREATE INDEX IF NOT EXISTS projects_org ON projects (org_id)`],
});

const codec = tableCodec<Project>(PROJECTS);

type Refusal = Exclude<ProjectMutation["status"], "ok">;
type Transform = (project: Project) => Project | Refusal;
type IsActive = (principalId: string) => boolean;

function effectiveMemberIds(project: Project): string[] {
  return [...new Set([...project.memberIds, ...(project.channelMemberIds ?? [])])];
}

function createProjectRows(databaseUrl: string) {
  const { q } = createPgPool(databaseUrl, [PROJECTS_MIGRATION]);
  const upsert = async (project: Project, onConflict: string): Promise<Project> =>
    codec.rows(
      await q(
        `INSERT INTO projects (${codec.columns}) VALUES (${codec.placeholders})
         ON CONFLICT (${tenantCols("id")}) DO UPDATE SET ${onConflict} RETURNING ${codec.columns}`,
        codec.values(project.id, project),
      ),
    )[0]!;
  return {
    load: async (id: string): Promise<Project | null> =>
      codec.rows(await q(`SELECT ${codec.columns} FROM projects WHERE id = $1`, [id]))[0] ?? null,
    save: (project: Project) => upsert(project, codec.updates),
    insertOrGet: (project: Project) => upsert(project, "id = projects.id"),
    listWhere: async (where: string, params: unknown[]): Promise<Project[]> =>
      codec.rows(
        await q(`SELECT ${codec.columns} FROM projects WHERE org_id = $1 AND ${where} ORDER BY updated_at DESC, id`, [
          tenant().orgId,
          ...params,
        ]),
      ),
  };
}

function rosterTransform(actorId: string, memberId: string, add: boolean, isActive: IsActive, now: () => number) {
  return (project: Project): Project | Refusal => {
    const canChangeRoster = add
      ? project.memberIds.some((member) => samePerson(member, actorId))
      : samePerson(project.ownerId, actorId);
    if (!canChangeRoster || !isActive(project.ownerId) || !isActive(actorId)) return "forbidden";
    if (samePerson(memberId, project.ownerId)) return "invalid_member";
    const memberIds = add
      ? [...new Set([...project.memberIds, memberId])]
      : project.memberIds.filter((member) => member !== memberId);
    if (
      memberIds.length === project.memberIds.length &&
      memberIds.every((member, i) => member === project.memberIds[i])
    )
      return project;
    return { ...project, memberIds, updatedAt: Math.max(now(), project.updatedAt + 1) };
  };
}

function slackLinkTransform(
  actorId: string,
  link: { channelId: string; channelName: string } | null,
  isActive: IsActive,
  now: () => number,
): Transform {
  return (project) => {
    const isMember = project.memberIds.some((member) => samePerson(member, actorId));
    if (!isMember || !isActive(project.ownerId) || !isActive(actorId)) return "forbidden";
    const current = project.slackChannel;
    if (!link) {
      if (!current) return project;
      const { slackChannel: _dropped, channelMemberIds: _members, ...rest } = project;
      return rest;
    }
    if (current && current.channelId === link.channelId && current.channelName === link.channelName) return project;
    const slackChannel = {
      channelId: link.channelId,
      channelName: link.channelName,
      linkedBy: actorId,
      linkedAt: now(),
    };
    return { ...project, slackChannel };
  };
}

function channelSyncTransform(
  memberIds: readonly string[],
  channelName: string | undefined,
  isActive: IsActive,
  now: () => number,
): Transform {
  const next = [...new Set(memberIds)].sort();
  return (project) => {
    if (!project.slackChannel || !isActive(project.ownerId)) return "forbidden";
    const current = [...(project.channelMemberIds ?? [])].sort();
    const sameMembers = current.length === next.length && current.every((m, i) => m === next[i]);
    const nextName = channelName ?? project.slackChannel.channelName;
    if (sameMembers && nextName === project.slackChannel.channelName) return project;
    return {
      ...project,
      channelMemberIds: next,
      slackChannel: { ...project.slackChannel, channelName: nextName },
      ...(sameMembers ? {} : { updatedAt: Math.max(now(), project.updatedAt + 1) }),
    };
  };
}

export function createProjectStore(
  databaseUrl: string,
  opts: {
    now?: () => number;
    id?: () => string;
    isActiveMember?: (principalId: string) => boolean;
    advisoryLock: AdvisoryLock;
  },
): ProjectStore {
  const now = opts.now ?? Date.now;
  const nextId = opts.id ?? randomUUID;
  const isActiveMember = opts.isActiveMember ?? (() => true);
  const advisoryLock = opts.advisoryLock;
  const queue = createKeyedQueue<string>();
  const { load, save, insertOrGet, listWhere } = createProjectRows(databaseUrl);
  const withLock = <T>(id: string, fn: () => Promise<T>): Promise<T> =>
    queue(id, () => advisoryLock.withLock(`project:${id}`, fn));

  async function projectForGroup(groupRef: string): Promise<Project | undefined> {
    const id = projectIdFromGroupRef(groupRef);
    if (!id) return undefined;
    const project = await load(id);
    return project?.orgId === tenant().orgId ? project : undefined;
  }

  function change(
    id: string,
    effect: ProjectMutationEffect | undefined,
    transform: Transform,
  ): Promise<ProjectMutation> {
    return withLock(id, async () => {
      const project = await load(id);
      if (!project) return { status: "not_found" };
      const next = transform(project);
      if (typeof next === "string") return { status: next };
      const changed = next !== project;
      const result = { status: "ok" as const, project: visible(changed ? await save(next) : project), changed };
      await effect?.(result);
      return result;
    });
  }

  async function mutate(
    id: string,
    actorId: string,
    memberId: string,
    add: boolean,
    effect?: ProjectMutationEffect,
  ): Promise<ProjectMutation> {
    if (!memberId) return { status: "invalid_member" };
    return change(id, effect, rosterTransform(actorId, memberId, add, isActiveMember, now));
  }

  return {
    async create(input) {
      const name = cleanName(input.name);
      if (!name || !input.ownerId) throw new Error("project requires name and ownerId");
      const at = now();
      const project: Project = {
        id: nextId(),
        orgId: tenant().orgId,
        name,
        ownerId: input.ownerId,
        memberIds: [input.ownerId],
        createdAt: at,
        updatedAt: at,
      };
      const stored = await insertOrGet(project);
      if (stored.createdAt !== project.createdAt || stored.ownerId !== project.ownerId)
        throw new Error("project id collision");
      return visible(stored);
    },
    async get(id) {
      const project = await load(id);
      return project ? visible(project) : null;
    },
    async listForMember(principalId) {
      if (!isActiveMember(principalId)) return [];
      return (await listWhere(`($2 = ANY(member_ids) OR $2 = ANY(channel_member_ids))`, [principalId]))
        .filter((project) => isActiveMember(project.ownerId))
        .map(visible);
    },
    addMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, true, effect),
    removeMember: (id, ownerId, memberId, effect) => mutate(id, ownerId, memberId, false, effect),
    async rename(id, ownerId, name, effect) {
      const clean = cleanName(name);
      if (!clean) return { status: "invalid_name" };
      return change(id, effect, (project) => {
        if (project.ownerId !== ownerId || !isActiveMember(ownerId)) return "forbidden";
        return project.name === clean ? project : { ...project, name: clean };
      });
    },
    setSlackChannel: (id, actorId, link, effect) =>
      change(id, effect, slackLinkTransform(actorId, link, isActiveMember, now)),
    syncChannelMembers: (id, memberIds, channelName, effect) =>
      change(id, effect, channelSyncTransform(memberIds, channelName, isActiveMember, now)),
    async listLinked() {
      return (await listWhere(`slack_channel IS NOT NULL`, []))
        .filter((project) => isActiveMember(project.ownerId))
        .map(visible);
    },
    async slackChannel(groupRef) {
      const project = await projectForGroup(groupRef);
      if (!project || !isActiveMember(project.ownerId) || !project.slackChannel) return undefined;
      return { ...project.slackChannel };
    },
    recognizes: isProjectGroupRef,
    async membership(groupRef, principalId) {
      const project = await projectForGroup(groupRef);
      return project
        ? isActiveMember(project.ownerId) &&
            isActiveMember(principalId) &&
            effectiveMemberIds(project).includes(principalId)
        : undefined;
    },
    async members(groupRef) {
      const project = await projectForGroup(groupRef);
      if (!project) return undefined;
      return isActiveMember(project.ownerId)
        ? effectiveMemberIds(project).filter((principalId) => isActiveMember(principalId))
        : [];
    },
    async version(groupRef) {
      const project = await projectForGroup(groupRef);
      return project ? String(project.updatedAt) : undefined;
    },
    async withVersion(groupRef, version, fn) {
      const id = projectIdFromGroupRef(groupRef);
      if (!id) return undefined;
      return withLock(id, async () => {
        const project = await load(id);
        if (!project || project.orgId !== tenant().orgId || String(project.updatedAt) !== version) return undefined;
        return fn();
      });
    },
    async name(groupRef) {
      const project = await projectForGroup(groupRef);
      return project && isActiveMember(project.ownerId) ? project.name : undefined;
    },
    async withRosterLock(id, fn) {
      return withLock(id, async () => {
        const project = await load(id);
        return project ? fn(visible(project)) : null;
      });
    },
  };
}
