import { isPrincipalType, PRINCIPAL_TYPES } from "../../types.ts";
import type { DirectoryMember } from "../../directory/directory-store.ts";
import { canonicalPerson } from "../../directory/person.ts";
import { sendJson } from "../http.ts";
import { audit, isObj } from "./shared.ts";
import { withActor, type ApiCtx, type Route } from "./route.ts";
import { tenant } from "../../tenant.ts";

const numOrUndef = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

function strings(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((item): item is string => typeof item === "string") : undefined;
}

function memberships<K extends "channelId" | "groupId">(
  v: unknown[],
  key: K,
): Array<Record<K, string> & { principalId: string }> {
  return v.filter(
    (m): m is Record<K, string> & { principalId: string } =>
      isObj(m) && typeof m[key] === "string" && typeof m.principalId === "string",
  );
}

function setPrincipalActive(active: boolean): (ctx: ApiCtx) => Promise<void> {
  return async ({ res, deps, params }) => {
    if (!deps.identity) return sendJson(res, 404, { error: "not_found" });
    const id = params.id!;
    if (!id) return sendJson(res, 404, { error: "not_found" });
    await (active ? deps.identity.reactivate(id) : deps.identity.deactivate(id));
    audit(deps, {
      principalId: id,
      action: active ? "principal.reactivate" : "principal.deactivate",
      resource: "principal",
      scopeLabel: tenant().orgScope,
    });
    return sendJson(res, 200, { ok: true, principalId: id, active });
  };
}

async function canonicalPrincipal(ctx: ApiCtx): Promise<void> {
  const { res, deps } = ctx;
  const id = ctx.params.id!;
  if (!id) return sendJson(res, 404, { error: "not_found" });
  await deps.identity?.refresh(true);
  return sendJson(res, 200, { principalId: id, canonicalId: canonicalPerson(id) });
}

async function pushDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, body } = ctx;
  const b = body as Record<string, unknown>;
  if (!Array.isArray(b.members) && !Array.isArray(b.channels) && !Array.isArray(b.groupMembers)) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "members[], channels[], and/or groupMembers[] required",
    });
  }
  if (
    b.partialChannels !== undefined &&
    (typeof b.partialChannels !== "boolean" ||
      (b.partialChannels &&
        (!Array.isArray(b.channels) ||
          !Array.isArray(b.channelMembers) ||
          numOrUndef(b.channelsSyncedAt) === undefined)))
  ) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: "partial channels require channels[], channelMembers[] and channelsSyncedAt",
    });
  }
  if (Array.isArray(b.members) && b.members.some((m) => isObj(m) && !isPrincipalType(m.type))) {
    return sendJson(res, 400, {
      error: "bad_request",
      message: `member type must be one of: ${PRINCIPAL_TYPES.join(", ")}`,
    });
  }
  if (typeof b.workspaceUrl === "string" && /^https:\/\/[^\s/]+$/.test(b.workspaceUrl.replace(/\/+$/, ""))) {
    await app.setDirectoryWorkspaceUrl(b.workspaceUrl.replace(/\/+$/, ""));
  }
  let memberCount: number | undefined;
  if (Array.isArray(b.members)) {
    const members = b.members
      .filter(
        (m): m is DirectoryMember =>
          isObj(m) && typeof m.principalId === "string" && typeof m.displayName === "string" && isPrincipalType(m.type),
      )
      .map((m) => ({
        principalId: m.principalId,
        displayName: m.displayName,
        type: m.type,
        ...(typeof m.slackId === "string" && m.slackId ? { slackId: m.slackId } : {}),
        ...(typeof m.avatarUrl === "string" && m.avatarUrl.startsWith("https://") ? { avatarUrl: m.avatarUrl } : {}),
      }));
    await app.upsertDirectory(members, numOrUndef(b.membersSyncedAt));
    memberCount = members.length;
  }
  let channelCount: number | undefined;
  if (Array.isArray(b.channels)) {
    const channels = b.channels.filter(
      (c): c is { channelId: string; name: string; isPrivate?: boolean; isExternal?: boolean } =>
        isObj(c) && typeof c.channelId === "string" && typeof c.name === "string",
    );
    const applied = await app.upsertChannels(
      channels,
      Array.isArray(b.channelMembers) ? memberships(b.channelMembers, "channelId") : undefined,
      numOrUndef(b.channelsSyncedAt),
      strings(b.channelRosterIds),
      Array.isArray(b.channelRevocations) ? memberships(b.channelRevocations, "channelId") : undefined,
      b.partialChannels === true,
    );
    if (b.partialChannels && !applied) return sendJson(res, 409, { error: "stale_directory_observation" });
    channelCount = channels.length;
  }
  let groupMemberCount: number | undefined;
  if (Array.isArray(b.groupMembers)) {
    const groupMembers = memberships(b.groupMembers, "groupId");
    await app.upsertGroups(groupMembers, numOrUndef(b.groupsSyncedAt), strings(b.groupIds), strings(b.groupRosterIds));
    groupMemberCount = groupMembers.length;
  }
  return sendJson(res, 200, {
    ok: true,
    ...(memberCount !== undefined ? { members: memberCount } : {}),
    ...(channelCount !== undefined ? { channels: channelCount } : {}),
    ...(groupMemberCount !== undefined ? { groupMembers: groupMemberCount } : {}),
  });
}

async function directoryMeta({ res, app }: ApiCtx): Promise<void> {
  return sendJson(res, 200, await app.directoryMeta());
}

const SLACK_ID_RE = /^[UW][A-Z0-9]{8,}$/;
async function resolveDirectory(ctx: ApiCtx): Promise<void> {
  const { res, app, url } = ctx;
  const q = (url.searchParams.get("q") ?? "").trim();
  if (!q) return sendJson(res, 400, { error: "bad_request", message: "q (a name to resolve) required" });
  const r = await app.resolveRecipient(q);
  let found: DirectoryMember[] = [];
  if (r.kind === "one") found = [r.member];
  else if (r.kind === "ambiguous") found = r.candidates;
  const matches = found.map((m) => {
    const slackId = m.slackId ?? (SLACK_ID_RE.test(m.principalId) ? m.principalId : undefined);
    return slackId ? { ...m, slackId } : m;
  });
  return sendJson(res, 200, { matches });
}

async function channelMembership(ctx: ApiCtx): Promise<void> {
  return sendJson(ctx.res, 200, {
    member: await ctx.app.channelMember(ctx.params.channelId!, ctx.params.principalId!),
  });
}

export const directoryRoutes: ReadonlyArray<Route<ApiCtx>> = [
  { method: "GET", path: "/v1/principals/:id/canonical", auth: "source", handle: canonicalPrincipal },
  { method: "GET", path: "/v1/directory/meta", auth: "source", handle: directoryMeta },
  {
    method: "GET",
    path: "/v1/directory/channels/:channelId/members/:principalId",
    auth: "source",
    handle: channelMembership,
  },
  { method: "GET", path: "/v1/directory/resolve", actor: "person", auth: "either", handle: resolveDirectory },
  ...withActor("system", [
    { method: "POST", path: "/v1/principals/:id/deactivate", auth: "source", handle: setPrincipalActive(false) },
    { method: "POST", path: "/v1/principals/:id/reactivate", auth: "source", handle: setPrincipalActive(true) },
    { method: "POST", path: "/v1/directory", auth: "source", handle: pushDirectory },
  ]),
];
