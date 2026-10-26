import {
  type ScopeId,
  parseScopeId,
  scopeId,
  type Destination,
  type SurfaceContextRequest,
  type SurfaceContextResult,
  type Cron,
} from "../types.ts";
import { personKey, personKeys, samePersonInDirectory, samePersonMatcher } from "../directory/person.ts";
import { reportFailureAs } from "../util/errors.ts";
import { adminCronHistoryUrl } from "../util/admin-links.ts";
import { randomUUID } from "node:crypto";
import {
  reachPost,
  withSlackUnfurlOption,
  withReact,
  withDelete,
  withThread,
  type ReachResolution,
} from "../reach/reach.ts";
import { isVisible } from "../directory/visibility.ts";
import { pickMatch, type DirectoryMember } from "../directory/directory-store.ts";
import { externalMemberActive } from "../identity/external-members.ts";
import { hasRevisionEvents, recordMessageRevisions } from "../core/message-revisions.ts";
import { answerWebContextRequest } from "./web-context.ts";
import { availableRuntimeError, validateRuntimeChoice } from "./runtime-config.ts";
import { assertCronRuntime } from "../cron/runtime.ts";
import { validateUserSchedule } from "../cron/schedule.ts";

import { type App, type AppDeps, type ReachNowResult, CONTEXT_REQUEST_EXPIRY_MS } from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import type { AmbientHelpers } from "./app-ambient.ts";
import { tenant } from "../tenant.ts";

export async function cronVisibility(deps: AppDeps, h: AppHelpers, principalId: string) {
  const viewerKeys = personKeys(await deps.directory.get(principalId).catch(() => null), principalId);
  const viewersOwn = (id: string): boolean => viewerKeys.has(personKey(id));
  const scopeNames = new Map<ScopeId, string | null>([[tenant().orgScope, null]]);
  if (deps.identity.isInternal(deps.identity.classify(principalId))) {
    for (const c of await deps.directory.listChannelsFor(principalId)) {
      scopeNames.set(scopeId("channel", c.channelId), c.name);
    }
  }
  for (const project of await h.projectsForViewer(principalId)) scopeNames.set(project.scopeId, project.name);
  const allowed = (ownerScopeId: ScopeId): boolean => {
    const { kind, ref } = parseScopeId(ownerScopeId);
    return kind !== "group" || deps.projects?.recognizes(ref) !== true || scopeNames.has(ownerScopeId);
  };
  return {
    viewersOwn,
    scopeNames,
    canSee: (c: Pick<Cron, "ownerScopeId" | "owner" | "destination">): boolean =>
      allowed(c.ownerScopeId) &&
      (viewersOwn(c.owner) ||
        scopeNames.has(c.ownerScopeId) ||
        (c.destination?.type === "principal" && viewersOwn(c.destination.target))),
  };
}

function settledContext(outcome: { result?: SurfaceContextResult; error?: string }): Partial<SurfaceContextRequest> {
  return outcome.error !== undefined
    ? { status: "failed", error: outcome.error }
    : { status: "done", result: outcome.result ?? { messages: [] } };
}

export function createMessagingMethods(deps: AppDeps, h: AppHelpers, ambient: AmbientHelpers) {
  const { adminBase, resolveReachTargetFor } = h;
  const { judgeAmbientContainer, ambientSelf } = ambient;
  const contextRequests = deps.contextRequests;
  const contextRequestListeners = new Set<(request: SurfaceContextRequest) => void>();
  const contextRequestTokens = new Map<string, string>();
  const identityMembers = async (): Promise<DirectoryMember[]> => {
    const [externals, participants] = await Promise.all([
      deps.identity.listExternalMembers(),
      deps.sessions?.distinctParticipants() ?? [],
    ]);
    const candidates: DirectoryMember[] = [
      ...(deps.emailAuthMembers ?? []),
      ...externals
        .filter((member) => externalMemberActive(member))
        .map((member) => ({ principalId: member.email, displayName: member.email, type: "internal" as const })),
      ...participants
        .filter((principalId) => deps.identity.classify(principalId).type === "internal")
        .map((principalId) => ({ principalId, displayName: principalId, type: "internal" as const })),
    ];
    const byKey = new Map<string, DirectoryMember>();
    for (const member of candidates) {
      const key = personKey(member.principalId);
      if (key && !byKey.has(key)) byKey.set(key, member);
    }
    return [...byKey.values()];
  };
  const mergedDirectoryMembers = async () => {
    const [stored, viaEmail] = await Promise.all([deps.directory.list(), identityMembers()]);
    const seen = new Set(stored.map((member) => personKey(member.principalId)));
    return [...stored, ...viaEmail.filter((member) => !seen.has(personKey(member.principalId)))];
  };

  const validateRuntime = async (cron: Pick<Cron, "runtime" | "ownerScopeId" | "action" | "message">) => {
    assertCronRuntime(cron);
    if (!cron.runtime) return;
    const error =
      validateRuntimeChoice(cron.runtime) ??
      (await availableRuntimeError({ deps }, cron.ownerScopeId, cron.runtime, "cron"));
    if (error) throw new Error(error);
  };

  return {
    async createCron(input) {
      await validateRuntime(input);
      validateUserSchedule(input.schedule);
      const cron = await deps.crons.create(input);
      h.audit(cron.createdBy, "cron_create", cron.id, cron.ownerScopeId);
      return cron;
    },
    getCron: (id) => deps.crons.get(id),
    listCronFires: (id, opts) => deps.crons.listFires(id, opts),
    cronFiresByThreadRefs: (threadRefs) => deps.crons.firesByThreadRefs(threadRefs),
    latestCronFireForThread: (id, threadRef) => deps.crons.latestFireForThread(id, threadRef),
    listCrons: () => deps.crons.list(),
    async listCronsForViewer(principalId) {
      const all = await deps.crons.list();
      const { viewersOwn, scopeNames, canSee } = await cronVisibility(deps, h, principalId);
      const owned = all.filter((c) => viewersOwn(c.owner) && canSee(c));
      const visible = all
        .filter((c) => !viewersOwn(c.owner))
        .filter(canSee)
        .map((c) => {
          const name = scopeNames.get(c.ownerScopeId);
          return name ? { ...c, scopeName: name } : c;
        });
      return { owned, visible };
    },
    async updateCron(id, patch) {
      const before = await deps.crons.get(id);
      if (!before) return null;
      if (patch.runtime !== undefined) await validateRuntime({ ...before, ...patch });
      if (patch.schedule) validateUserSchedule(patch.schedule);
      const grantsReaffirmed = patch.unattendedGrants !== undefined;
      const guardedPatch =
        (before.unattendedGrants?.length ?? 0) > 0 && !grantsReaffirmed ? { ...patch, unattendedGrants: [] } : patch;
      const updated = await deps.crons.update(id, guardedPatch);
      h.audit(before.owner, "cron_update", id, before.ownerScopeId);
      return updated;
    },
    async deleteCron(id) {
      const before = await deps.crons.get(id);
      await deps.crons.delete(id);
      if (before) h.audit(before.owner, "cron_delete", id, before.ownerScopeId);
    },
    setCronEnabled: (id, enabled) => deps.crons.setEnabled(id, enabled),
    async setCronFireNote(id, note) {
      const before = await deps.crons.get(id);
      if (!before) return "missing";
      const outcome = await deps.crons.setFireNote(id, note);
      if (outcome === "applied") {
        h.audit(note.by ?? before.owner, "cron_note", id, before.ownerScopeId);
      }
      return outcome;
    },
    async setCronRuntime(id, runtime) {
      const before = await deps.crons.get(id);
      if (!before) return null;
      await validateRuntime({ ...before, runtime });
      return deps.crons.update(id, { runtime });
    },
    async setCronDestination(id, destination) {
      const before = await deps.crons.get(id);
      if (!before) return null;
      await deps.crons.setDestination(id, destination);
      h.audit(before.owner, "cron_retarget", id, before.ownerScopeId);
      return deps.crons.get(id);
    },
    async createWebhook(input) {
      const webhook = await deps.webhooks.create(input);
      h.audit(webhook.createdBy, "webhook_create", webhook.id, webhook.ownerScopeId);
      return webhook;
    },
    getWebhook: (id) => deps.webhooks.get(id),
    async listWebhookEvents(id, viewer) {
      const events = await deps.webhooks.listEvents(id);
      return Promise.all(
        events.map(async (event) => {
          const session = await deps.sessions.getByThread(`webhook:${id}:${event.deliveryId}`);
          const visible = session && (await h.sessionForViewer(session.id, viewer));
          return { ...event, ...(visible ? { sessionId: session.id } : {}) };
        }),
      );
    },
    listWebhooks: () => deps.webhooks.list(),
    setWebhookEnabled: (id, enabled) => deps.webhooks.setEnabled(id, enabled),
    updateWebhook: (id, patch) => deps.webhooks.update(id, patch),
    async postToSurface(input) {
      await deps.outbound.send(input);
    },
    async ingestSurfaceEvents(events, surface = "slack", self) {
      if (!deps.surfaceCache || !events.length) return { upserted: 0 };
      if (self && (self.name || self.mentionId)) ambientSelf.set(`${tenant().orgId}:${surface}`, self);
      const out = await deps.surfaceCache.ingest(events.map((event) => ({ ...event, surface })));
      if (surface === "slack" && hasRevisionEvents(events)) {
        void recordMessageRevisions(deps.sessions, events).catch(
          reportFailureAs("revisions: surface revision record", undefined),
        );
      }
      for (const container of new Set(events.filter((e) => !e.self).map((e) => e.container))) {
        void judgeAmbientContainer(surface, container).catch(reportFailureAs("ambient: judge", undefined));
      }
      return out;
    },
    searchSurface: async (queryText, opts) => (await deps.surfaceCache?.search(queryText, opts)) ?? [],
    readSurfaceMessages: async (container, opts) => (await deps.surfaceCache?.readMessages(container, opts)) ?? [],
    listSurfaceContainers: async (opts) => (await deps.surfaceCache?.listContainers(opts)) ?? [],
    getChannelPolicy: async (container) => (await deps.channelPolicy?.get(container)) ?? null,
    setChannelPolicy: async (container, orders, setBy, bots, sessionId, ambientEnabled) =>
      (await deps.channelPolicy?.set(container, orders, { setBy, bots, sessionId, ambientEnabled })) ?? null,
    judgeAmbientContainer: (surface, container) => judgeAmbientContainer(surface, container),
    async createContextRequest(source, query) {
      const { viewerToken, ...storedQuery } = query;
      const request: SurfaceContextRequest = {
        id: randomUUID(),
        source,
        createdAt: Date.now(),
        status: "pending",
        query: storedQuery,
      };
      await contextRequests.put(request.id, request);
      if (viewerToken) contextRequestTokens.set(request.id, viewerToken);
      if (source === "web") {
        const outcome: { result?: SurfaceContextResult; error?: string } = await answerWebContextRequest(
          deps.sessions,
          query,
        ).catch(reportFailureAs("context: web conversation read", { error: "the web conversation couldn't be read" }));
        await contextRequests.merge(request.id, settledContext(outcome));
        return request;
      }
      for (const l of contextRequestListeners) l(viewerToken ? { ...request, query } : request);
      return request;
    },
    onContextRequestCreated(listener) {
      contextRequestListeners.add(listener);
      return () => contextRequestListeners.delete(listener);
    },
    getContextRequest: (id) => contextRequests.get(id),
    async deleteContextRequest(id) {
      contextRequestTokens.delete(id);
      return contextRequests.delete(id);
    },
    async pendingContextRequests(source) {
      const all = await contextRequests.all();
      const now = Date.now();
      const stale = all.filter((r) => r.status === "pending" && now - r.createdAt > CONTEXT_REQUEST_EXPIRY_MS);
      await Promise.all(stale.map((r) => (contextRequestTokens.delete(r.id), contextRequests.delete(r.id))));
      return all
        .filter((r) => r.source === source && r.status === "pending" && now - r.createdAt <= CONTEXT_REQUEST_EXPIRY_MS)
        .map((r) => {
          const token = contextRequestTokens.get(r.id);
          return token ? { ...r, query: { ...r.query, viewerToken: token } } : r;
        });
    },
    async fulfillContextRequest(id, outcome) {
      contextRequestTokens.delete(id);
      return (await contextRequests.merge(id, settledContext(outcome))) != null;
    },
    setRunDeliveryState: (runId, state) => deps.runs.setDeliveryState(runId, null, state),

    async upsertDirectory(members, syncedAt) {
      const previous = await deps.directory.list();
      if (!(await deps.directory.replace(members, syncedAt))) return false;
      const present = members.filter((m) => m.type === "internal").map((m) => m.principalId);
      const presentSet = new Set(present);
      const removed = previous.map((m) => m.principalId).filter((id) => !presentSet.has(id));
      const outcome = await deps.identity.recordDirectorySync(removed, present);
      const orgScope = tenant().orgScope;
      for (const id of outcome.deactivated) h.audit(id, "principal.deactivate", "directory-sync", orgScope);
      for (const id of outcome.reactivated) h.audit(id, "principal.reactivate", "directory-sync", orgScope);
      return true;
    },
    async upsertChannels(channels, channelMembers, syncedAt, channelRosterIds, revocations, partial) {
      const applied = await deps.directory.replaceChannels(
        channels,
        channelMembers,
        syncedAt,
        channelRosterIds,
        revocations,
        partial,
      );
      await h.syncLinkedProjectRosters();
      return applied;
    },
    upsertGroups: (...args) => deps.directory.replaceGroups(...args),
    async setDirectoryWorkspaceUrl(url) {
      await deps.directory.setWorkspaceUrl(url);
    },
    directoryMeta: () => deps.directory.meta(),
    channelMember: (channelId, principalId) => deps.directory.channelMember(channelId, principalId),
    channelVisibleTo(actorId, channelId, isPrivate) {
      return isVisible(deps.directory, actorId, {
        kind: "channel",
        channelId,
        ...(isPrivate !== undefined ? { isPrivate } : {}),
      });
    },
    async resolveRecipient(query) {
      const stored = await deps.directory.resolve(query);
      if (stored.kind !== "none") return stored;
      const match = pickMatch(
        await identityMembers(),
        query,
        (member) => member.principalId,
        (member) => member.displayName,
      );
      if (match.kind === "one") return { kind: "one", member: match.item };
      if (match.kind === "ambiguous") return { kind: "ambiguous", candidates: match.items };
      return { kind: "none" };
    },
    resolveChannel: (query) => deps.directory.resolveChannel(query),
    directoryMembers: () => mergedDirectoryMembers(),
    directoryChannels: () => deps.directory.listChannels(),
    async directoryMember(principalId) {
      return (
        (await deps.directory.get(principalId)) ??
        (await identityMembers()).find((member) => personKey(member.principalId) === personKey(principalId)) ??
        null
      );
    },
    samePerson: (a, b) => samePersonInDirectory(deps.directory, a, b),
    personMatcher: (actorId) => samePersonMatcher(deps.directory, actorId),
    cronAdminUrl: (cron) => (adminBase ? adminCronHistoryUrl(adminBase, cron.ownerScopeId, cron.id) : undefined),
    async channelName(channelId) {
      const chan = (await deps.directory.listChannels()).find((c) => c.channelId === channelId);
      return chan ? `#${chan.name.replace(/^#/, "")}` : undefined;
    },
    ...(deps.ambientJudge ? { ambientJudge: deps.ambientJudge } : {}),
    async reachNow(input): Promise<ReachNowResult> {
      const hasNamedTarget =
        input.recipient !== undefined || input.channel !== undefined || input.participants !== undefined;
      let baseDestination: Destination;
      const extra: {
        recipient?: { principalId: string; displayName: string };
        channel?: { channelId: string; name: string };
        group?: { groupId: string };
      } = {};
      if (input.delete && !hasNamedTarget) {
        const dest = input.currentDestination;
        if (!dest?.target)
          return {
            ok: false,
            status: 400,
            error: "no_conversation",
            message: "this conversation has no message surface to delete from — name a channel or its participants",
          };
        baseDestination = dest;
      } else {
        const r: ReachResolution = await resolveReachTargetFor(
          {
            ...(input.recipient !== undefined ? { recipient: input.recipient } : {}),
            ...(input.channel !== undefined ? { channel: input.channel } : {}),
            ...(input.participants !== undefined ? { participants: input.participants } : {}),
          },
          input.senderId,
          { mayOpenGroup: !input.react && !input.delete },
        );
        if (!r.ok) return r;
        baseDestination = r.destination;
        if (r.recipient) extra.recipient = r.recipient;
        if (r.channel) extra.channel = r.channel;
        if (r.group) extra.group = r.group;
      }
      if (input.threadTs) {
        if (
          baseDestination.type !== "slack" &&
          baseDestination.type !== "group" &&
          baseDestination.type !== "principal"
        ) {
          return {
            ok: false,
            status: 400,
            error: "bad_request",
            message: "threadTs requires a Slack channel, group DM, or person DM",
          };
        }
        baseDestination = withThread(baseDestination, input.threadTs);
      }
      const sender = await deps.directory.get(input.senderId).catch(() => null);
      const idempotencyKey = `reach:${randomUUID()}`;
      await reachPost({
        outbound: deps.outbound,
        destination: withDelete(
          withReact(withSlackUnfurlOption(baseDestination, input.unfurlLinks), input.react),
          input.delete,
        ),
        text: input.text ?? "",
        idempotencyKey,
        ...(input.attachments?.length ? { attachments: input.attachments } : {}),
        ...(!input.react && !input.delete && sender?.displayName ? { attributeAs: sender.displayName } : {}),
      });
      h.audit(input.senderId, "reach_now", idempotencyKey, input.senderScope);
      return { ok: true, ...extra };
    },

    resolveReachTarget: (target, authorityId, opts) => resolveReachTargetFor(target, authorityId, opts),
  } satisfies Partial<App>;
}
