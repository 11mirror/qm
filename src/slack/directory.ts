import { companySlackActor, type ExternalSlackAccess } from "./external-access.ts";
import {
  type ActorAssertion,
  type CachedUser,
  type ChannelMembership,
  type ChannelMeta,
  type SlackIdentityMode,
  type SlackUser,
  allInternalChannelMembers,
  internalChannelMembers,
  classifyUser,
  createUserCache,
  externalMarker,
  isExternallyShared,
  probeIdentityMode,
  resolveChannelMembership,
  slackUserTimezone,
} from "./identity.ts";
import { createRefreshCoalescer } from "./message-gating.ts";
import { isReservedMentionName, setMentionIndex } from "./mrkdwn.ts";
import { sleep } from "../util/async.ts";
import { errMessage, swallow, swallowAs } from "../util/errors.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";

export interface BotIdentity {
  ownTeamId: string;
  botUserId: string;
  ownBotId: string;
  botHandle: string;
  ownWorkspaceUrl: string;
  identityMode: SlackIdentityMode;
}

interface UserSnapshot {
  byId: Map<string, CachedUser>;
  fetchedAt: number;
}

type ChannelInvalidations = ReadonlyMap<string, ReadonlySet<string>>;
type RosterRef = { id: string; info?: ChannelMeta };
type RosterKind = { plural: string; authz: string; item: string; limit?: number; requireComplete?: boolean };

const MEMBERS_PAGE_LIMIT = 200;
const ROSTER_FETCH_CONCURRENCY = 4;
export type Directory = ReturnType<typeof createDirectory>;

export function createDirectory(deps: {
  externalAccess?: ExternalSlackAccess;
  core: SlackCoreClient;
  ids: BotIdentity;
  userSnapshotTtlMs?: number;
  channelMembersTtlMs?: number;
  syncRetryMs?: number;
  maxPrivateChannels?: number;
  userCacheTtlMs?: number;
  coreSingleton?: boolean;
}) {
  const { core, ids } = deps;
  const CORE_SINGLETON = deps.coreSingleton !== false;
  const USER_SNAPSHOT_TTL_MS = deps.userSnapshotTtlMs ?? 5 * 60_000;
  const CHANNEL_MEMBERS_TTL_MS = deps.channelMembersTtlMs ?? 30 * 60_000;
  const SYNC_RETRY_MS = deps.syncRetryMs ?? 30_000;
  const MAX_PRIVATE_CHANNELS = deps.maxPrivateChannels ?? Infinity;
  const userCache = createUserCache(deps.userCacheTtlMs ? { ttlMs: deps.userCacheTtlMs } : {});
  const classify = (u: SlackUser | undefined): ActorAssertion =>
    deps.externalAccess ? companySlackActor(u, deps.externalAccess) : classifyUser(u, ids.ownTeamId, ids.identityMode);

  let userSnapshot: UserSnapshot | undefined;
  let userSnapshotInFlight: Promise<UserSnapshot> | undefined;
  let lastFullRosterFetchAt: number | undefined;
  const seenGroupIds = new Set<string>();

  async function refreshUserSnapshot(client: any): Promise<UserSnapshot> {
    const fetchedAt = Date.now();
    const byId = new Map<string, CachedUser>();
    const mentionIndex = new Map<string, string>();
    const ambiguousNames = new Set<string>();
    const indexName = (name: string | undefined, id: string): void => {
      const key = (name ?? "").trim().toLowerCase();
      if (!key || isReservedMentionName(key) || ambiguousNames.has(key)) return;
      const existing = mentionIndex.get(key);
      if (existing && existing !== id) {
        mentionIndex.delete(key);
        ambiguousNames.add(key);
        return;
      }
      mentionIndex.set(key, id);
    };
    let missingEmails = 0;
    for await (const res of client.paginate("users.list", { limit: 1000 }) as AsyncIterable<any>) {
      for (const u of (res.members ?? []) as SlackUser[]) {
        if (!u?.id || u.id === ids.botUserId) continue;
        const actor = classify(u);
        if (ids.identityMode === "email" && !u.is_bot && actor.externalId === u.id && u.team_id === ids.ownTeamId)
          missingEmails++;
        const timezone = slackUserTimezone(u);
        const avatarUrl = u.profile?.image_72;
        byId.set(u.id, { actor, ...(timezone ? { timezone } : {}), ...(avatarUrl ? { avatarUrl } : {}) });
        if (!u.deleted) for (const name of [u.name, u.profile?.display_name, u.real_name]) indexName(name, u.id);
      }
    }
    if (CORE_SINGLETON) setMentionIndex(mentionIndex);
    if (missingEmails > 0) {
      console.warn(
        `[slack] email identity mode: ${missingEmails} own-team member(s) have no visible email (missing users:read.email scope?) — they fail closed to guest`,
      );
    }
    return { byId, fetchedAt };
  }

  async function listBotConversations(client: any, types: string): Promise<Array<ChannelMeta & { id: string }>> {
    const out: Array<ChannelMeta & { id: string }> = [];
    for await (const res of client.paginate("conversations.list", {
      types,
      exclude_archived: true,
      limit: 1000,
    }) as AsyncIterable<any>) {
      for (const c of res.channels ?? []) if (c?.id && c.is_member) out.push(c);
    }
    return out;
  }

  async function fetchChannelMemberIds(client: any, channel: string): Promise<string[]> {
    const memberIds: string[] = [];
    for await (const res of client.paginate("conversations.members", {
      channel,
      limit: MEMBERS_PAGE_LIMIT,
    }) as AsyncIterable<any>) {
      for (const id of res.members ?? []) if (id !== ids.botUserId) memberIds.push(id);
    }
    return memberIds;
  }

  async function allInternalRosters(
    client: any,
    refs: ReadonlyArray<RosterRef>,
    kind: RosterKind,
  ): Promise<Map<string, string[]>> {
    const classified = await allClassifiedRosters(client, refs, kind);
    const rosters = new Map<string, string[]>();
    for (const ref of refs) {
      const roster = classified.get(ref.id);
      const internalIds = roster && allInternalChannelMembers(roster.actors, roster.complete, ref.info);
      if (internalIds) rosters.set(ref.id, internalIds);
    }
    return rosters;
  }

  async function allClassifiedRosters(
    client: any,
    refs: ReadonlyArray<RosterRef>,
    kind: RosterKind,
  ): Promise<Map<string, { actors: ActorAssertion[]; complete: boolean }>> {
    const rosters = new Map<string, { actors: ActorAssertion[]; complete: boolean }>();
    const limit = kind.limit ?? Infinity;
    const queue = refs.slice(0, limit);
    if (refs.length > queue.length) {
      console.error(
        `[slack-plugin] ${refs.length} ${kind.plural} exceed the cap (${limit}); ${refs.length - queue.length} omitted from ${kind.authz} authorization`,
      );
    }
    await Promise.all(
      Array.from({ length: Math.min(ROSTER_FETCH_CONCURRENCY, queue.length) }, async () => {
        for (let ref = queue.pop(); ref; ref = queue.pop()) {
          let memberIds: string[];
          try {
            memberIds = await fetchChannelMemberIds(client, ref.id);
          } catch (err) {
            if (kind.requireComplete) throw err;
            console.error(
              "%s",
              `[slack-plugin] members fetch failed for ${kind.item} ${ref.id}:`,
              (err as Error).message,
            );
            continue;
          }
          const actors: ActorAssertion[] = [];
          let complete = true;
          for (const id of memberIds) {
            const { actor, ok } = await classifyUserCached(client, id);
            actors.push(actor);
            if (!ok) {
              if (kind.requireComplete) throw new Error("Slack mirror member classification unavailable");
              complete = false;
            }
          }
          rosters.set(ref.id, { actors, complete });
        }
      }),
    );
    return rosters;
  }

  async function fetchChannels(
    client: any,
    invalidations: ChannelInvalidations,
    targetChannelIds?: ReadonlySet<string>,
  ) {
    const fetchedAt = Date.now();
    let listed: Array<ChannelMeta & { id: string; name: string }>;
    try {
      const all = (await listBotConversations(client, "public_channel,private_channel")).filter(
        (c): c is ChannelMeta & { id: string; name: string } => Boolean(c.name),
      );
      listed = [...all.filter((c) => !c.is_private), ...all.filter((c) => c.is_private)];
    } catch (err) {
      console.error("[slack-plugin] channel list failed:", (err as Error).message);
      return null;
    }
    const channels = listed.map((c) => ({
      channelId: c.id,
      name: c.name,
      ...(c.is_private ? { isPrivate: true } : {}),
      ...(isExternallyShared(c) ? { isExternal: true } : {}),
    }));
    const fullRefresh =
      !targetChannelIds?.size &&
      (lastFullRosterFetchAt === undefined || fetchedAt - lastFullRosterFetchAt >= CHANNEL_MEMBERS_TTL_MS);
    const refs = listed.filter((c) => fullRefresh || targetChannelIds?.has(c.id));
    const publicCount = refs.filter((c) => !c.is_private).length;
    const rosters = await allClassifiedRosters(client, refs, {
      plural: "channels",
      authz: "channel",
      item: "channel",
      limit: publicCount + Math.min(refs.length - publicCount, MAX_PRIVATE_CHANNELS),
    });
    const channelMembers: Array<{ channelId: string; principalId: string }> = [];
    const channelRosterIds: string[] = [];
    for (const { id: channelId } of refs) {
      const roster = rosters.get(channelId);
      const internalIds = roster && internalChannelMembers(roster.actors, roster.complete);
      if (!internalIds) continue;
      channelRosterIds.push(channelId);
      const revoked = invalidations.get(channelId);
      for (const principalId of internalIds)
        if (!revoked?.has(principalId)) channelMembers.push({ channelId, principalId });
    }
    const channelRevocations = [...invalidations].flatMap(([channelId, principalIds]) =>
      [...principalIds].map((principalId) => ({ channelId, principalId })),
    );
    let groups = {};
    if (fullRefresh) {
      try {
        const groupsSyncedAt = Date.now();
        const groupIds = (await listBotConversations(client, "mpim")).map((c) => c.id);
        for (const id of groupIds) seenGroupIds.add(id);
        const groupRosters = await allInternalRosters(
          client,
          groupIds.map((id) => ({ id })),
          { plural: "group DMs", authz: "group-DM-send", item: "group DM", limit: groupIds.length },
        );
        const groupMembers = groupIds.flatMap((groupId) =>
          (groupRosters.get(groupId) ?? []).map((principalId) => ({ groupId, principalId })),
        );
        groups = { groupMembers, groupIds, groupRosterIds: [...groupRosters.keys()], groupsSyncedAt };
      } catch (err) {
        console.error("[slack-plugin] group-DM list failed:", (err as Error).message);
      }
    }
    return {
      push: { channels, channelMembers, channelRosterIds, channelRevocations, channelsSyncedAt: fetchedAt, ...groups },
      fullRosterFetchedAt: fullRefresh ? fetchedAt : undefined,
    };
  }

  async function pushDirectory(
    snap: UserSnapshot,
    client: any,
    invalidations: ChannelInvalidations = new Map(),
    targetChannelIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    if (!CORE_SINGLETON) return true;
    let pushed: boolean | null;
    try {
      pushed = await core.holdDirectorySync(async (lost) => {
        let lostFlag = false;
        void lost.then(() => {
          lostFlag = true;
        });
        return crawlAndPush(snap, client, invalidations, () => lostFlag, targetChannelIds);
      });
    } catch (err) {
      console.error("[slack-plugin] directory sync lease failed:", errMessage(err));
      return false;
    }
    if (pushed === null) console.log("[slack-plugin] directory sync skipped: the sync lease is held elsewhere");
    return pushed ?? false;
  }

  async function crawlAndPush(
    snap: UserSnapshot,
    client: any,
    invalidations: ChannelInvalidations,
    leaseLost: () => boolean,
    targetChannelIds?: ReadonlySet<string>,
  ): Promise<boolean> {
    const members = [...snap.byId.entries()]
      .filter(([, u]) => !u.actor.isExternalGuest)
      .map(([slackId, { actor: a, avatarUrl }]) => ({
        principalId: a.externalId,
        displayName: a.displayName ?? a.externalId,
        type: "internal" as const,
        ...(slackId && slackId !== a.externalId ? { slackId } : {}),
        ...(avatarUrl ? { avatarUrl } : {}),
      }));
    const fetched = await fetchChannels(client, invalidations, targetChannelIds);
    if (leaseLost()) {
      console.error("[slack-plugin] directory sync lease lost mid-crawl — discarding the crawl");
      return false;
    }
    if (!members.length && !fetched?.push.channels.length) return false;
    try {
      const applied = await core.pushDirectory({
        members,
        membersSyncedAt: snap.fetchedAt,
        ...fetched?.push,
        ...(ids.ownWorkspaceUrl ? { workspaceUrl: ids.ownWorkspaceUrl } : {}),
      });
      if (applied && fetched?.fullRosterFetchedAt !== undefined) lastFullRosterFetchAt = fetched.fullRosterFetchedAt;
      if (!applied) console.warn("[slack-plugin] directory push refused by the store (stale stamp) — will retry");
      return fetched !== null && applied;
    } catch (err) {
      console.error("[slack-plugin] directory push failed:", (err as Error).message);
      return false;
    }
  }

  async function getUserSnapshot(client: any): Promise<UserSnapshot | undefined> {
    if (!ids.ownTeamId) return undefined;
    const snap = userSnapshot;
    const stale = !snap || Date.now() - snap.fetchedAt >= USER_SNAPSHOT_TTL_MS;
    if (stale && !userSnapshotInFlight) {
      userSnapshotInFlight = refreshUserSnapshot(client)
        .then(async (s) => {
          userSnapshot = s;
          await pushDirectory(s, client);
          return s;
        })
        .finally(() => {
          userSnapshotInFlight = undefined;
        });
      userSnapshotInFlight.catch(swallowAs("slack: user snapshot refresh", undefined));
    }
    return snap ?? userSnapshotInFlight?.catch(() => undefined);
  }

  let directorySyncClient: any;
  const invalidatedChannelMembers = new Map<string, Set<string>>();
  const targetedChannelIds = new Set<string>();
  let fullDirectorySyncRequested = false;
  let syncRetryTimer: NodeJS.Timeout | undefined;
  function scheduleSyncRetry(): void {
    if (syncRetryTimer) return;
    syncRetryTimer = setTimeout(() => {
      syncRetryTimer = undefined;
      void coalescedDirectorySync().catch(swallowAs("slack: directory sync retry", undefined));
    }, SYNC_RETRY_MS);
    syncRetryTimer.unref?.();
  }
  const coalescedDirectorySync = createRefreshCoalescer(async () => {
    const fullSync = fullDirectorySyncRequested;
    fullDirectorySyncRequested = false;
    const scheduledTargets = new Set(targetedChannelIds);
    const targets = fullSync || !scheduledTargets.size ? undefined : scheduledTargets;
    if (!targets) lastFullRosterFetchAt = undefined;
    const snap = userSnapshot ?? (await getUserSnapshot(directorySyncClient));
    const pendingInvalidations = new Map(
      [...invalidatedChannelMembers].map(([channelId, principalIds]) => [channelId, new Set(principalIds)]),
    );
    if (snap && (await pushDirectory(snap, directorySyncClient, pendingInvalidations, targets))) {
      for (const channelId of scheduledTargets) targetedChannelIds.delete(channelId);
      for (const [channelId, principalIds] of pendingInvalidations) {
        const current = invalidatedChannelMembers.get(channelId);
        for (const principalId of principalIds) current?.delete(principalId);
        if (!current?.size) invalidatedChannelMembers.delete(channelId);
      }
    } else {
      if (fullSync) fullDirectorySyncRequested = true;
      if (fullDirectorySyncRequested || targetedChannelIds.size || invalidatedChannelMembers.size) scheduleSyncRetry();
    }
  });

  function forceDirectorySync(
    client: any,
    invalidateChannelId?: string,
    invalidatePrincipalId?: string,
  ): Promise<void> {
    directorySyncClient = client;
    if (!invalidateChannelId) fullDirectorySyncRequested = true;
    else {
      if (invalidatePrincipalId) {
        const principals = invalidatedChannelMembers.get(invalidateChannelId) ?? new Set<string>();
        principals.add(invalidatePrincipalId);
        invalidatedChannelMembers.set(invalidateChannelId, principals);
      }
      targetedChannelIds.add(invalidateChannelId);
    }
    return coalescedDirectorySync();
  }

  function syncForUnseenGroup(client: any, groupId: string): void {
    if (seenGroupIds.has(groupId)) return;
    seenGroupIds.add(groupId);
    void forceDirectorySync(client).catch(swallowAs("slack: unseen group-DM directory sync", undefined));
  }

  async function classifyUserCached(client: any, userId: string | undefined): Promise<CachedUser & { ok: boolean }> {
    const cached = userId === undefined ? undefined : userCache.get(userId);
    if (cached) return { ...cached, ok: true };
    const fromSnapshot = (await getUserSnapshot(client))?.byId.get(userId ?? "");
    if (fromSnapshot) return { ...fromSnapshot, ok: true };
    try {
      const user = (await client.users.info({ user: userId })).user as SlackUser | undefined;
      const timezone = slackUserTimezone(user);
      const classified = { actor: classify(user), ...(timezone ? { timezone } : {}) };
      if (ids.ownTeamId && userId !== undefined) userCache.set(userId, classified);
      return { ...classified, ok: true };
    } catch (err) {
      swallow("slack: users.info classify", err);
      return { actor: { externalId: userId ?? "", isExternalGuest: true }, ok: false };
    }
  }

  async function getChannelInfo(client: any, channel: string): Promise<ChannelMeta | undefined> {
    try {
      return (await client.conversations.info({ channel })).channel as ChannelMeta;
    } catch (err) {
      swallow("slack: conversations.info", err);
      return undefined;
    }
  }

  async function channelMembership(
    client: any,
    channel: string,
    actor: ActorAssertion,
    actorSlackId: string | undefined,
    info: ChannelMeta | undefined,
    observedAt?: number,
  ): Promise<ChannelMembership> {
    let membership: ChannelMembership;
    try {
      const memberIds = await fetchChannelMemberIds(client, channel);
      membership = await resolveChannelMembership({
        memberIds,
        actor,
        actorSlackId,
        info,
        classify: (id) => classifyUserCached(client, id),
      });
    } catch (err) {
      swallow("slack: channel membership", err);
      return { audience: [actor, externalMarker()] };
    }
    if (CORE_SINGLETON && !deps.externalAccess && !actor.isBot && !info?.is_mpim) {
      if (!info?.name || typeof info.is_private !== "boolean" || info.is_member === false || observedAt === undefined)
        return { audience: [actor, externalMarker()] };
      if (membership.publishMembers) {
        const applied = await core.pushDirectory({
          channels: [{ channelId: channel, name: info.name, isPrivate: info.is_private }],
          channelMembers: membership.publishMembers.map((member) => ({
            channelId: channel,
            principalId: member.externalId,
          })),
          channelRosterIds: [channel],
          channelsSyncedAt: observedAt,
          partialChannels: true,
        });
        if (!applied) throw new Error("Slack channel membership was not persisted before admission");
      }
    }
    return membership;
  }

  async function resolveAutoIdentityMode(client: any): Promise<SlackIdentityMode> {
    for (let attempt = 1; ; attempt++) {
      try {
        let sawOwnTeamHuman = false;
        for await (const res of client.paginate("users.list", { limit: 1000 }) as AsyncIterable<{
          members?: SlackUser[];
        }>) {
          const evidence = probeIdentityMode(res.members ?? [], ids.ownTeamId);
          if (evidence === "email") return "email";
          if (evidence === "slack-id") sawOwnTeamHuman = true;
        }
        return sawOwnTeamHuman ? "slack-id" : "email";
      } catch (err) {
        if (attempt >= 3) {
          throw new Error(
            `identity-mode probe failed after ${attempt} attempts (${errMessage(err)}) — refusing to start rather than guess the principal keying; set SLACK_IDENTITY_EMAIL=1 or =0 to skip the probe`,
            { cause: err },
          );
        }
        await sleep(attempt * 2000);
      }
    }
  }

  return {
    getUserSnapshot,
    forceDirectorySync,
    classifyUserCached,
    classifyActor: async (client: any, userId: string) => (await classifyUserCached(client, userId)).actor,
    getChannelInfo,
    channelMembership,
    allInternalRosters,
    syncForUnseenGroup,
    resolveAutoIdentityMode,
  };
}
