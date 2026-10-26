import { swallowAs } from "../util/errors.ts";
import { composeSoul } from "../resolution/resolution-service.ts";
import { createCurrentScopeMembers } from "../resolution/scope-membership.ts";
import { notifyDeploymentShared } from "../deploy/share-notice.ts";
import { deploymentShareScope } from "../deploy/email-access.ts";
import { workingSessionThreadRefs } from "../sessions/session-syscalls.ts";
import {
  type GetItemsOptions,
  type ParticipantPageQuery,
  acquireLeaseWithin,
  itemWithinTenure,
  windowedTranscript,
} from "../sessions/session-store.ts";
import { type PendingApprovalRecord, type ScopeId, type Session, parseScopeId, scopeId } from "../types.ts";
import { fileArtifactId, artifactPath } from "../files/file-artifact-store.ts";
import { isUserMessage, messageTs, proseText, type Item, type NewItem } from "../sessions/items.ts";
import { createTranscriptSource, type TranscriptSource } from "../sessions/transcript-source.ts";
import { cancelGoal, goalCancelledItem, openGoal } from "../harness/goal.ts";
import { goalView } from "../runs/turn-stream.ts";
import { SEARCH_HIT_LIMIT, searchSnippet, searchTerms } from "../sessions/entry-search.ts";
import { supportsProcessSessions } from "../sandbox/sandbox.ts";
import { ProcessSessionGoneError } from "../sandbox/exec-process-session.ts";
import { cronIsActive, cronTiedTo } from "../cron/cron-store.ts";
import { cronRef, deployRef, encodeRef, fileRef, parseRef, skillRef, type ResourceRef } from "../acl/resource-ref.ts";
import { samePerson } from "../directory/person.ts";
import { AdminError } from "../admin/admin-service.ts";
import { type ArtifactHome } from "./artifact-share.ts";
import { randomUUID } from "node:crypto";
import { isOpenScopeMember } from "../resolution/sharing-access.ts";
import { MAX_ATTACHMENT_BYTES, mimeFromName, safeAttachmentName } from "../core/attachments.ts";
import { projectIdFromGroupRef, projectScopeId, type Project, type ProjectStore } from "../projects/project-store.ts";

import {
  type App,
  type AppDeps,
  SoulUpdateDeniedError,
  SoulVersionConflictError,
  toFileItem,
  type ScopeDeployment,
  type SessionPinView,
  type SessionSearchHit,
  type TranscriptWindow,
} from "./app-types.ts";
import type { AppHelpers } from "./app-helpers.ts";
import { tenant } from "../tenant.ts";

const MAX_SESSION_PINS = 50;
const MAX_PIN_TEXT_CHARS = 2000;
const PIN_PREVIEW_CHARS = 240;
const ENTRIES_PER_TURN_ESTIMATE = 40;
const TAIL_WINDOW_ENTRY_CAP = 2000;

type ReadTranscript = (opts?: GetItemsOptions) => ReturnType<TranscriptSource["forRender"]>;

async function readTail(read: ReadTranscript, window?: TranscriptWindow) {
  let limit =
    window?.tailTurns === undefined || window.sinceSeq !== undefined
      ? undefined
      : Math.min(window.tailTurns * ENTRIES_PER_TURN_ESTIMATE, TAIL_WINDOW_ENTRY_CAP);
  let result = await read({ limit, beforeSeq: window?.beforeSeq, sinceSeq: window?.sinceSeq });
  while (limit !== undefined && result.earlier > 0 && result.items.filter(isUserMessage).length < window!.tailTurns!) {
    limit *= 2;
    result = await read({ limit, beforeSeq: window?.beforeSeq });
  }
  const w = windowedTranscript(result.items, window);
  return { all: result.items, items: w.items, earlier: w.earlier + result.earlier };
}

const GOAL_CANCEL_LEASE_WAIT_MS = 30_000;

const MAX_LISTED_CHILDREN = 500;

export function createSessionMethods(deps: AppDeps, h: AppHelpers) {
  const transcripts = createTranscriptSource(deps.sessions);
  const pinView = (
    rec: { id: string; text?: string; entrySeq?: number; addedBy: string; createdAt: number },
    entry?: Item,
  ): SessionPinView => {
    const preview = entry ? proseText(entry) : null;
    return {
      id: rec.id,
      ...(rec.text ? { text: rec.text } : {}),
      ...(rec.entrySeq !== undefined ? { entrySeq: rec.entrySeq } : {}),
      ...(preview ? { preview: preview.slice(0, PIN_PREVIEW_CHARS) } : {}),
      addedBy: rec.addedBy,
      createdAt: rec.createdAt,
    };
  };

  const decoratedPins = async (
    pins: readonly { id: string; text?: string; entrySeq?: number; addedBy: string; createdAt: number }[],
    visibleToReader: readonly Item[],
    resolveMissing: (seq: number) => Promise<Item | undefined>,
  ): Promise<SessionPinView[]> => {
    if (!pins.length) return [];
    const bySeq = new Map(visibleToReader.map((e) => [e.seq, e]));
    return Promise.all(
      pins.map(async (p) => {
        const entry =
          p.entrySeq !== undefined ? (bySeq.get(p.entrySeq) ?? (await resolveMissing(p.entrySeq))) : undefined;
        return pinView(p, entry);
      }),
    );
  };

  const readFor =
    (sessionId: string, principalId?: string): ReadTranscript =>
    (opts) =>
      principalId === undefined
        ? transcripts.forRender(sessionId, opts)
        : transcripts.forViewer(sessionId, principalId, opts);

  const tenureOf = async (sessionId: string, principalId: string) =>
    (await deps.sessions.participantWindowsOf(sessionId)).find((w) => w.principalId === principalId);

  const viewerStoredEntryAt = async (sessionId: string, principalId: string, seq: number) => {
    const window = await tenureOf(sessionId, principalId);
    if (!window) return undefined;
    const entry = await deps.sessions.getItem(sessionId, seq);
    return entry && itemWithinTenure(entry, window) ? entry : undefined;
  };

  const entryAt = async (sessionId: string, seq: number, principalId?: string) => {
    const latest = await deps.sessions.latestItemSeq(sessionId);
    if (seq > latest) return undefined;
    const read = readFor(sessionId, principalId);
    let scoped = (await read({ limit: latest - seq + 1 })).items;
    if (scoped.length && scoped[0]!.seq > seq) scoped = (await read()).items;
    return (
      scoped.find((e) => e.seq === seq) ??
      (await (principalId === undefined
        ? deps.sessions.getItem(sessionId, seq)
        : viewerStoredEntryAt(sessionId, principalId, seq)))
    );
  };

  const slackDmChannel = (session: { surface?: string; threadRef: string }): string | null => {
    if (session.surface !== "slack" || !session.threadRef.startsWith("dm:")) return null;
    return session.threadRef.split(":")[1] || null;
  };

  const mirrorNativePin = async (
    session: { id: string; surface?: string; threadRef: string },
    pinId: string,
    entrySeq: number | undefined,
    remove: boolean,
  ): Promise<void> => {
    if (entrySeq === undefined || !deps.outbound) return;
    const channel = slackDmChannel(session);
    if (!channel) return;
    const entry = await entryAt(session.id, entrySeq);
    const ts = entry ? messageTs(entry) : null;
    if (!ts) return;
    await deps.outbound
      .send({
        destination: { type: "slack", target: channel, pin: { messageTs: ts, ...(remove ? { remove: true } : {}) } },
        text: "",
        idempotencyKey: `session-pin:${pinId}:${remove ? "remove" : "add"}`,
      })
      .catch(swallowAs("pins: mirror the pin in Slack", undefined));
  };

  const editableProject = async (id: string, principalId: string) => {
    if (!deps.projects) return { status: "not_found" as const };
    if (!deps.identity.isInternal(deps.identity.classify(principalId))) return { status: "forbidden" as const };
    const existing = await deps.projects.get(id);
    if (!existing || existing.orgId !== tenant().orgId) return { status: "not_found" as const };
    return { status: "ok" as const, existing, projects: deps.projects };
  };

  const withProjectView = async (result: Awaited<ReturnType<ProjectStore["rename"]>>) =>
    result.status === "ok" ? { ...result, project: await h.projectView(result.project) } : result;

  const continuable = async (principalId: string, session: Session): Promise<Session> => ({
    ...session,
    canContinue: await h.canContinueOnWeb(principalId, session),
  });

  const withProjectMembers = <T>(
    groupRef: string,
    principalId: string,
    fn: (members: readonly string[], project: Project) => Promise<T>,
  ): Promise<T | null> => {
    const projects = deps.projects;
    if (!projects) return Promise.resolve(null);
    return projects.withRosterLock(projectIdFromGroupRef(groupRef)!, async (project) => {
      if (project.orgId !== tenant().orgId) return null;
      const members = await projects.members(groupRef);
      return members?.includes(principalId) ? fn(members, project) : null;
    });
  };

  async function decorateSessions(principalId: string, all: Session[]): Promise<Session[]> {
    const visibleById = new Map(all.map((session) => [session.id, session]));
    const roots = all.map((session) => session.id);
    const descendants = roots.length ? await deps.sessions.descendantsOf(roots) : [];
    const descendantIds = new Set(descendants.map((d) => d.id));
    const approvalRows: PendingApprovalRecord[] = [];
    const approvalIds = [...visibleById.keys(), ...descendantIds];
    const approvals = approvalIds.length
      ? await deps.approvals?.selectEntries({ where: { field: "sessionId", anyOfFold: approvalIds } })
      : [];
    for (const [, record] of approvals ?? []) {
      const session = visibleById.get(record.sessionId);
      if (
        session
          ? await h.approvalRecordIsCurrent(record, session)
          : descendantIds.has(record.sessionId) && (await h.approvalRecordIsCurrent(record))
      )
        approvalRows.push(record);
    }
    const waiting = new Set(approvalRows.filter((r) => r.blocksInput !== false).map((r) => r.sessionId));
    const workingThreadRefs = await workingSessionThreadRefs(deps.sessions, deps.runs, waiting);
    const sharedAccess = new Map<string, Promise<boolean>>(
      all
        .filter((s) => {
          const { kind, ref } = parseScopeId(s.scopeId);
          return kind === "group" && projectIdFromGroupRef(ref);
        })
        .map((s) => [s.scopeId, Promise.resolve(true)]),
    );
    const sessions = await Promise.all(
      all
        .filter(
          (s) =>
            s.hasEntries !== false ||
            Boolean(s.title?.trim()) ||
            workingThreadRefs.has(s.threadRef) ||
            waiting.has(s.id),
        )
        .map(async ({ hasEntries: _hasEntries, ...s }) => ({
          ...s,
          canContinue: await h.canContinueOnWeb(principalId, s, sharedAccess),
        })),
    );
    const now = Date.now();
    const tally = (refs: Array<string | undefined>) => {
      const counts = new Map<string, number>();
      for (const ref of refs) if (ref) counts.set(ref, (counts.get(ref) ?? 0) + 1);
      return counts;
    };
    const jobCounts = tally(
      ((await deps.processes?.listLive(now)) ?? []).map((rec) =>
        rec.kind === "background" ? rec.sessionRef : undefined,
      ),
    );
    const watchCounts = tally(
      ((await deps.monitors?.enabled()) ?? []).map((m) => (m.expiresAt > now ? m.threadRef : undefined)),
    );
    const cronCounts = tally(
      (await deps.crons.list())
        .filter(cronIsActive)
        .flatMap((c) => [...new Set([c.destination?.target, c.sessionRef])]),
    );
    const working = sessions.filter((s) => workingThreadRefs.has(s.threadRef));
    const idleChildren = sessions.filter(
      (s) => s.parentSessionId && !workingThreadRefs.has(s.threadRef) && !waiting.has(s.id),
    );
    const [latestRuns, sessionGoals] = await Promise.all([
      deps.runs.latestForThreads([...working, ...idleChildren].map((s) => s.threadRef)),
      deps.sessions.goals(working.map((s) => s.id)),
    ]);
    const failedChildren = new Set<string>();
    for (const s of idleChildren) {
      const run = latestRuns.get(s.threadRef);
      if (run?.status === "failed" || run?.result?.status === "failed") failedChildren.add(s.id);
    }
    const goals = new Map<
      string,
      { objective: string; activeMs: number; runningSince?: number; floor?: Record<string, number> }
    >();
    for (const s of working) {
      const goal = openGoal(sessionGoals.get(s.id));
      if (!goal) continue;
      const runningSince = latestRuns.get(s.threadRef)?.startedAt ?? undefined;
      if (goal.status === "active")
        goals.set(s.id, {
          objective: goal.objective,
          activeMs: goal.activeMs ?? 0,
          ...(runningSince ? { runningSince: Math.max(runningSince, goal.activeSince ?? goal.createdAt) } : {}),
          ...(goal.floor ? { floor: { ...goal.floor } } : {}),
        });
    }
    const subagents = new Map<string, { running: number; waiting: number }>();
    for (const d of descendants) {
      const isWaiting = waiting.has(d.id);
      if (!isWaiting && !workingThreadRefs.has(d.threadRef)) continue;
      const counts = subagents.get(d.rootId) ?? { running: 0, waiting: 0 };
      counts[isWaiting ? "waiting" : "running"]++;
      subagents.set(d.rootId, counts);
    }
    return sessions.map((s) => ({
      ...s,
      ...(workingThreadRefs.has(s.threadRef) ? { working: true } : {}),
      ...(waiting.has(s.id) ? { awaitingInput: true } : {}),
      ...(failedChildren.has(s.id) ? { lastTurnFailed: true } : {}),
      ...(jobCounts.has(s.threadRef) ? { backgroundJobs: jobCounts.get(s.threadRef)! } : {}),
      ...(watchCounts.has(s.threadRef) ? { watches: watchCounts.get(s.threadRef)! } : {}),
      ...(cronCounts.has(s.threadRef) ? { crons: cronCounts.get(s.threadRef)! } : {}),
      ...(goals.has(s.id) ? { goal: goals.get(s.id)! } : {}),
      ...(subagents.has(s.id) ? { subagents: subagents.get(s.id)! } : {}),
    }));
  }

  return {
    async getSession(sessionId, window) {
      const session = await deps.sessions.get(sessionId);
      if (!session) return null;
      const [read, pinRecords] = await Promise.all([
        readTail(readFor(sessionId), window),
        deps.sessions.listPins(sessionId),
      ]);
      const pins = await decoratedPins(pinRecords, read.all, (seq) => deps.sessions.getItem(sessionId, seq));
      return {
        session,
        items: read.items,
        ...(read.earlier > 0 ? { earlierItems: read.earlier } : {}),
        ...(pins.length ? { pins } : {}),
      };
    },

    async canViewSessionSnapshot(sessionId, principalId, visibility) {
      if (
        !visibility ||
        ![visibility.minSeq, visibility.maxSeq, visibility.minCreatedAt, visibility.maxCreatedAt].every(
          Number.isFinite,
        ) ||
        visibility.minSeq > visibility.maxSeq ||
        visibility.minCreatedAt > visibility.maxCreatedAt
      )
        return false;
      if (!(await h.sessionForViewer(sessionId, principalId))) return false;
      const window = await tenureOf(sessionId, principalId);
      return (
        !!window &&
        itemWithinTenure({ seq: visibility.minSeq, createdAt: visibility.minCreatedAt }, window) &&
        itemWithinTenure({ seq: visibility.maxSeq, createdAt: visibility.maxCreatedAt }, window)
      );
    },

    async getSessionForViewer(sessionId, principalId, window) {
      const found = await h.sessionForViewer(sessionId, principalId);
      if (!found) return null;
      const session = await continuable(principalId, found);
      const [read, pinRecords, goals, latestRuns] = await Promise.all([
        readTail(readFor(sessionId, principalId), window),
        deps.sessions.listPins(sessionId),
        deps.sessions.goals([sessionId]),
        window?.beforeSeq === undefined ? deps.runs.latestForThreads([found.threadRef]) : undefined,
      ]);
      const goal = openGoal(goals.get(sessionId));
      const runtime = latestRuns?.get(found.threadRef)?.result?.runtime;
      const pins = await decoratedPins(pinRecords, read.all, (seq) => viewerStoredEntryAt(sessionId, principalId, seq));
      return {
        session,
        items: read.items,
        ...(read.earlier > 0 ? { earlierItems: read.earlier } : {}),
        ...(pins.length ? { pins } : {}),
        ...(goal ? { goal: goalView(goal) } : {}),
        ...(runtime ? { runtime } : {}),
      };
    },

    async pinConversationItem(threadRef, addedBy, pin) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return { error: "not_found" };
      const text = pin.text?.trim().slice(0, MAX_PIN_TEXT_CHARS);
      if (pin.entrySeq !== undefined) {
        const exists = (await entryAt(session.id, pin.entrySeq, addedBy)) !== undefined;
        if (!exists) return { error: "bad_entry" };
      }
      const rec = await deps.sessions.addPin(
        session.id,
        {
          ...(text ? { text } : {}),
          ...(pin.entrySeq !== undefined ? { entrySeq: pin.entrySeq } : {}),
          addedBy,
        },
        MAX_SESSION_PINS,
      );
      if (!rec) return (await deps.sessions.get(session.id)) ? { error: "limit" } : { error: "not_found" };
      await mirrorNativePin(session, rec.id, rec.entrySeq, false);
      const pinned = rec.entrySeq !== undefined ? await entryAt(session.id, rec.entrySeq, addedBy) : undefined;
      return { pin: pinView(rec, pinned) };
    },

    async listConversationPins(threadRef, reader) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return null;
      const pinRecords = await deps.sessions.listPins(session.id);
      if (!pinRecords.length) return [];
      const seqs = pinRecords.filter((p) => p.entrySeq !== undefined).map((p) => p.entrySeq!);
      const resolveMissing = (seq: number) => viewerStoredEntryAt(session.id, reader, seq);
      if (!seqs.length) return decoratedPins(pinRecords, [], resolveMissing);
      const latest = await deps.sessions.latestItemSeq(session.id);
      const minSeq = Math.min(...seqs);
      const visible = (await transcripts.forViewer(session.id, reader, { limit: Math.max(1, latest - minSeq + 1) }))
        .items;
      return decoratedPins(pinRecords, visible, resolveMissing);
    },

    async unpinConversationItem(threadRef, pinId) {
      const session = await deps.sessions.getByThread(threadRef);
      if (!session) return null;
      const rec = (await deps.sessions.listPins(session.id)).find((p) => p.id === pinId);
      const removed = await deps.sessions.removePin(session.id, pinId);
      if (removed && rec) await mirrorNativePin(session, rec.id, rec.entrySeq, true);
      return removed;
    },

    async getSessionItemForViewer(sessionId, principalId, seq) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      const item = await entryAt(sessionId, seq, principalId);
      return item ? { item } : null;
    },

    listFilesForViewer: (principalId, opts, inScope) => h.filesForViewer(principalId, opts, inScope),

    async uploadFileForViewer(principalId, input) {
      const ownerScopeId = scopeId("personal", principalId);
      const createdInScope = input.scopeId ?? ownerScopeId;
      if (!(await h.principalCanAccessCurrentScope(principalId, createdInScope))) return null;
      const name = safeAttachmentName(input.name);
      const mimetype = (input.mimetype ?? mimeFromName(name)).split(";")[0]!.trim().toLowerCase() || mimeFromName(name);
      const id = fileArtifactId(`upload:${principalId}:${createdInScope}:${Date.now()}:${randomUUID()}`, "in", 0);
      const path = artifactPath(id, name);
      const { artifact } = await deps.files.put({
        id,
        ownerScopeId,
        createdBy: principalId,
        name,
        path,
        mimetype,
        data: input.data,
        direction: "in",
        createdInScope,
        maxBytes: MAX_ATTACHMENT_BYTES,
      });
      if (createdInScope !== ownerScopeId) {
        await deps.acl.grant({
          ownerScopeId,
          ref: artifact.id,
          granteeScopeId: createdInScope,
          permission: "read",
          grantedBy: principalId,
        });
      }
      h.audit(principalId, "file.upload", path, createdInScope);
      return toFileItem(artifact);
    },

    async openFileForViewer(id, principalId) {
      const art = await deps.files.get(id);
      if (!art) return null;
      const myScopes = await h.currentResourceScopesForViewer(principalId);
      let allowed = myScopes.includes(art.ownerScopeId);
      if (!allowed) {
        const grants = await deps.acl.grantsFor(art.ownerScopeId, art.id);
        allowed = grants.some((g) => myScopes.includes(g.granteeScopeId));
      }
      if (!allowed) return null;
      const opened = await deps.files.open(id);
      if (!opened) return null;
      return { name: art.name, mimetype: art.mimetype, sizeBytes: opened.sizeBytes, stream: opened.stream };
    },

    listSessions: async (principalId) => decorateSessions(principalId, await h.sessionsForViewer(principalId)),

    async listSessionPage(principalId, query) {
      const filter: ParticipantPageQuery = {
        limit: Math.max(1, Math.min(query.limit, 200)),
        archived: query.status === "archived",
        ...(query.before ? { before: query.before } : {}),
        ...(query.surface ? { surface: query.surface } : {}),
        ...(query.scopeId ? { scopeId: query.scopeId } : {}),
        ...(query.titleQuery ? { titleQuery: query.titleQuery } : {}),
      };
      if (query.status === "waiting") {
        const pending = ((await deps.approvals?.all()) ?? []).filter((record) => record.blocksInput !== false);
        filter.sessionIds = [...new Set(pending.map((record) => record.sessionId))];
      }
      const firstPage = !query.before && query.status !== "archived";
      const [page, pinned, archived] = await Promise.all([
        deps.sessions.listParticipantPage(principalId, {
          ...filter,
          ...(query.status === "archived" ? {} : { pinned: false }),
        }),
        firstPage ? deps.sessions.listParticipantPage(principalId, { ...filter, pinned: true, limit: 200 }) : null,
        firstPage ? deps.sessions.listParticipantPage(principalId, { ...filter, archived: true, limit: 1 }) : null,
      ]);
      const rows = await h.viewableRows(principalId, [...(pinned?.sessions ?? []), ...page.sessions]);
      let decorated = await decorateSessions(principalId, rows);
      if (query.status === "waiting") decorated = decorated.filter((s) => s.awaitingInput);
      const pinnedIds = new Set(pinned?.sessions.map((s) => s.id) ?? []);
      return {
        sessions: decorated.filter((s) => !pinnedIds.has(s.id)),
        ...(pinned ? { pinned: decorated.filter((s) => pinnedIds.has(s.id)) } : {}),
        ...(archived ? { hasArchived: archived.sessions.length > 0 } : {}),
        next: page.next,
      };
    },

    async sessionChildren(principalId, sessionId) {
      const root = await h.sessionForViewer(sessionId, principalId);
      if (!root) return null;
      const children = await deps.sessions.listDescendantsForParticipant(root.id, principalId, MAX_LISTED_CHILDREN);
      return decorateSessions(principalId, children);
    },

    async sessionRow(principalId, ref) {
      const id = ref.id ?? (ref.threadRef ? (await deps.sessions.getByThread(ref.threadRef))?.id : undefined);
      if (!id) return null;
      const session = await h.sessionForViewer(id, principalId);
      if (!session) return null;
      const { spawnMeta: _spawnMeta, clientTools: _clientTools, ...row } = session;
      const [decorated] = await decorateSessions(principalId, [row]);
      return decorated ?? null;
    },

    async searchSessions(principalId, query, limit = SEARCH_HIT_LIMIT): Promise<SessionSearchHit[]> {
      const capped = Math.max(1, Math.min(Math.floor(limit), 100));
      const [hits, titles] = await Promise.all([
        deps.sessions.searchEntries(principalId, query, capped).then((rows) => h.viewableRows(principalId, rows)),
        deps.sessions.searchSessionTitles(principalId, query, capped).then((rows) => h.viewableRows(principalId, rows)),
      ]);
      const terms = searchTerms(query);
      const entryHits: SessionSearchHit[] = hits.map((hit) => ({
        sessionId: hit.sessionId,
        title: hit.title ?? null,
        scopeId: hit.scopeId,
        ...(hit.channelName ? { channelName: hit.channelName } : {}),
        ...(hit.surface ? { surface: hit.surface } : {}),
        seq: hit.seq,
        entryType: hit.type,
        ...(hit.author ? { author: hit.author } : {}),
        snippet: searchSnippet(hit.text, terms),
        createdAt: hit.createdAt,
        ...(hit.archived ? { archived: true } : {}),
      }));
      const entryHitSessions = new Set(entryHits.map((hit) => hit.sessionId));
      const titleHits: SessionSearchHit[] = titles
        .filter((s) => !entryHitSessions.has(s.id))
        .map((s) => ({
          sessionId: s.id,
          title: s.title ?? null,
          scopeId: s.scopeId,
          ...(s.channelName ? { channelName: s.channelName } : {}),
          ...(s.surface ? { surface: s.surface } : {}),
          seq: 0,
          entryType: "title",
          snippet: s.title ?? s.id,
          createdAt: s.lastActivityAt ?? s.createdAt,
          ...(s.archived ? { archived: true } : {}),
        }));
      return [...titleHits, ...entryHits].slice(0, capped);
    },

    async sessionBackground(sessionId, viewer) {
      const session = await h.sessionForViewer(sessionId, viewer);
      if (!session) return null;
      const now = Date.now();
      const jobs = ((await deps.processes?.listLive(now)) ?? [])
        .filter((r) => r.kind === "background" && r.sessionRef === session.threadRef)
        .sort((a, b) => b.startedAt - a.startedAt)
        .map((r) => ({
          processId: r.processId,
          command: r.command,
          ...(r.purpose ? { purpose: r.purpose } : {}),
          startedAt: r.startedAt,
          expiresAt: r.expiresAt,
        }));
      const watches = ((await deps.monitors?.enabled()) ?? [])
        .filter((m) => m.threadRef === session.threadRef && m.expiresAt > now)
        .sort((a, b) => b.createdAt - a.createdAt)
        .map((m) => ({
          id: m.id,
          processId: m.processId,
          command: m.command,
          ...(m.pattern !== undefined ? { pattern: m.pattern } : {}),
          ...(m.instructions !== undefined ? { instructions: m.instructions } : {}),
          createdAt: m.createdAt,
          expiresAt: m.expiresAt,
          ...(m.lastFiredAt !== undefined ? { lastFiredAt: m.lastFiredAt } : {}),
        }));
      const crons = await Promise.all(
        (await deps.crons.list())
          .filter((c) => cronIsActive(c) && cronTiedTo(c, session.threadRef))
          .sort((a, b) => b.createdAt - a.createdAt)
          .map(async (c) => {
            const last = (await deps.crons.listFires(c.id, { limit: 1 })).runs[0];
            return {
              id: c.id,
              ...(c.title !== undefined ? { title: c.title } : {}),
              ...(c.nextFireAt !== undefined ? { nextFireAt: c.nextFireAt } : {}),
              ...(last ? { lastFire: { firedAt: last.firedAt, ...(last.status ? { status: last.status } : {}) } } : {}),
            };
          }),
      );
      return { jobs, watches, crons };
    },

    async readSessionBackgroundOutput(sessionId, processId, viewer, sinceCursor) {
      const session = await h.sessionForViewer(sessionId, viewer);
      if (!session || !deps.processes || !deps.sandbox || !supportsProcessSessions(deps.sandbox)) return null;
      const sandbox = deps.sandbox;
      const rec = await deps.processes.get(processId);
      if (!rec || rec.kind !== "background" || rec.sessionRef !== session.threadRef) return null;
      const handle = await sandbox.provision(
        [{ scopeId: rec.scopeId, mode: "rw", mountPath: "" }],
        rec.sandboxId ? { sandboxId: rec.sandboxId } : undefined,
      );
      try {
        const read = await sandbox.readProcess(handle, processId, { sinceCursor, maxBytes: 65_536, waitMs: 0 });
        return {
          chunk: read.chunks,
          cursor: read.cursor,
          state: read.status.state,
          ...(read.status.state === "exited" ? { exitCode: read.status.code } : {}),
        };
      } catch (e) {
        if (e instanceof ProcessSessionGoneError) return { chunk: "", cursor: sinceCursor, state: "exited" };
        throw e;
      } finally {
        await sandbox
          .teardown(handle, { keepWarm: true })
          .catch(swallowAs("app sessions: release process sandbox", undefined));
      }
    },

    listContexts: (principalId) => h.contextsFor(principalId),

    listProjects: async (principalId) => h.projectsForViewer(principalId),

    async createProject(principalId, name) {
      const principal = deps.identity.classify(principalId);
      if (!deps.projects || !deps.identity.isInternal(principal) || !name.trim()) return null;
      const project = await deps.projects.create({ name, ownerId: principalId });
      h.audit(principalId, "project.create", project.id, projectScopeId(project.id));
      return h.projectView(project);
    },

    async addProjectMember(id, principalId, memberId) {
      const gate = await editableProject(id, principalId);
      if (gate.status !== "ok") return gate;
      const directoryMember = await h.directoryMember(memberId);
      const principal = deps.identity.classify(memberId);
      if (!directoryMember || directoryMember.type !== "internal" || !deps.identity.isInternal(principal))
        return { status: "invalid_member" };
      return withProjectView(
        await gate.projects.addMember(id, principalId, memberId, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.member.add", memberId, projectScopeId(project.id));
          await h.reconcileProjectMember(project, memberId, true);
        }),
      );
    },

    async removeProjectMember(id, principalId, memberId) {
      const gate = await editableProject(id, principalId);
      if (gate.status !== "ok") return gate;
      return withProjectView(
        await gate.projects.removeMember(id, principalId, memberId, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.member.remove", memberId, projectScopeId(project.id));
          await h.reconcileProjectMember(project, memberId, false);
        }),
      );
    },

    async setProjectSlackChannel(id, principalId, channel) {
      const gate = await editableProject(id, principalId);
      if (gate.status !== "ok") return gate;
      const { existing, projects } = gate;
      let link: { channelId: string; channelName: string } | null = null;
      if (channel !== null) {
        const wanted = channel.trim().replace(/^#/, "");
        if (!wanted) return { status: "invalid_channel" };
        const findChannel = async () => {
          const reachable = await deps.directory.listChannelsFor(principalId).catch(() => []);
          return (
            reachable.find((c) => c.channelId === wanted) ??
            reachable.find((c) => c.name.toLowerCase() === wanted.toLowerCase())
          );
        };
        let match = await findChannel();
        if (!match) {
          await h.refreshSurfaceDirectory().catch(() => undefined);
          match = await findChannel();
        }
        if (!match) return { status: "invalid_channel" };
        if (await deps.sessions.scopeHasSessions(scopeId("channel", match.channelId)))
          return { status: "channel_in_use" };
        link = { channelId: match.channelId, channelName: match.name };
      }
      const prevDerived = existing.channelMemberIds ?? [];
      const manual = new Set([existing.ownerId, ...existing.memberIds]);
      const result = await projects.setSlackChannel(id, principalId, link, async ({ project, changed }) => {
        if (changed)
          h.audit(
            principalId,
            link ? "project.slack_channel.link" : "project.slack_channel.unlink",
            link?.channelId ?? existing.slackChannel?.channelId ?? "",
            projectScopeId(project.id),
          );
        if (!link) {
          for (const m of prevDerived) {
            if (manual.has(m)) continue;
            h.audit(principalId, "project.member.remove", m, projectScopeId(project.id));
            await h.reconcileProjectMember(project, m, false);
          }
        }
      });
      if (result.status !== "ok") return result;
      if (link) await h.syncProjectChannelRoster(result.project, principalId);
      return withProjectView({ ...result, project: (await projects.get(id)) ?? result.project });
    },

    async renameProject(id, principalId, name) {
      const gate = await editableProject(id, principalId);
      if (gate.status !== "ok") return gate;
      return withProjectView(
        await gate.projects.rename(id, principalId, name, async ({ project, changed }) => {
          if (changed) h.audit(principalId, "project.rename", project.id, projectScopeId(project.id));
        }),
      );
    },

    async listScopeResources(principalId, scope) {
      if (!(await h.principalCanAccessCurrentScope(principalId, scope))) return null;
      const [page, allCrons, allWebhooks, allDeployments, allSkills] = await Promise.all([
        h.filesForViewer(principalId, undefined, scope),
        deps.crons.list(),
        deps.webhooks.list(),
        deps.deploy.listDeployments(),
        deps.skills.list(),
      ]);
      const files = [...page.owned, ...page.shared];
      let cursor = page.nextCursor;
      while (cursor) {
        const next = await h.filesForViewer(principalId, { limit: 200, cursor }, scope);
        files.push(...next.owned, ...next.shared);
        cursor = next.nextCursor;
      }
      files.sort((a, b) => b.createdAt - a.createdAt);
      const deployments = (
        await Promise.all(
          allDeployments
            .filter((d) => d.createdInScope === scope || d.ownerScopeId === scope)
            .map(async (d): Promise<ScopeDeployment | null> => {
              const permission = await h.principalGitPermission(d, principalId);
              return permission
                ? {
                    id: d.id,
                    name: d.displayName ?? d.name ?? d.id,
                    status: d.status,
                    permission,
                    currentVersion: d.currentVersion,
                  }
                : null;
            }),
        )
      ).filter((d): d is ScopeDeployment => d != null);
      const skills = allSkills
        .filter((s) => s.scopeId === scope)
        .map((s) => ({ id: s.id, name: s.manifest.name, description: s.manifest.description, status: s.status }));
      return {
        files,
        webhooks: allWebhooks.filter((w) => w.ownerScopeId === scope),
        crons: allCrons.filter((c) => c.ownerScopeId === scope),
        deployments,
        skills,
        manageable: await h.principalCanManageScope(principalId, scope),
      };
    },

    managesScope: (principalId, scope) => h.principalCanManageScope(principalId, scope),

    currentScopeMembers: createCurrentScopeMembers(
      {
        managedGroups: deps.projects,
        directory: deps.directory,
        identity: deps.identity,
      },
      true,
    ),
    isCurrentSharedScopeMember(principalId, scope) {
      const { kind } = parseScopeId(scope);
      return kind === "channel" || kind === "group"
        ? h.principalCanWriteScope(principalId, scope)
        : Promise.resolve(false);
    },

    isOpenScopeMember(principalId, scope) {
      return isOpenScopeMember({
        actorId: principalId,
        scope,
        isCurrentSharedScopeMember: h.principalCanWriteScope,
      });
    },

    membershipControlsScope: (scope) => h.membershipControlsScope(scope),

    authorizesCapabilityScope: async (claims) => h.authorizesCapabilityScope(claims),

    async updateSession(sessionId, principalId, patch) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      await deps.sessions.updateParticipantView(sessionId, principalId, patch);
      const updated = await h.sessionForViewer(sessionId, principalId);
      return updated && continuable(principalId, updated);
    },

    async detachSession(sessionId, principalId) {
      const detach = async () => {
        const session = await h.sessionForViewer(sessionId, principalId);
        if (!session?.parentSessionId || !(await h.principalCanWriteScope(principalId, session.scopeId))) return null;
        await deps.sessions.setParentSession(sessionId, null);
        return { detached: true as const };
      };
      return deps.advisoryLock.withLock("session-tree-admission", () =>
        deps.advisoryLock.withLock("session-run-admission", detach),
      );
    },

    async cancelSessionGoal(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session || !(await h.mayWriteSession(principalId, session))) return null;
      const currentGoal = async () => openGoal((await deps.sessions.goals([session.id])).get(session.id));
      const before = await currentGoal();
      if (!before) return { cancelled: false as const, reason: "no_open_goal" as const };
      let { lease } = await deps.sessions.acquireLease(session.id, "backfill");
      if (!lease) {
        if (before.status === "active")
          for (const run of await deps.runs.inFlightForThread(session.threadRef))
            if (run.status === "running")
              await deps.signals?.send(run.id, { kind: "abort", reason: "because its goal was cancelled" });
        ({ lease } = await acquireLeaseWithin(deps.sessions, session.id, "backfill", GOAL_CANCEL_LEASE_WAIT_MS));
      }
      if (!lease) return { cancelled: false as const, reason: "busy" as const };
      try {
        const goal = await currentGoal();
        if (!goal) return { cancelled: false as const, reason: "no_open_goal" as const };
        cancelGoal(goal, "Cancelled from the goal bar.");
        await deps.sessions.setGoal(lease, goal, [goalCancelledItem(goal, principalId)]);
        return { cancelled: true as const };
      } finally {
        await deps.sessions.releaseLease(lease);
      }
    },

    async regenerateTitle(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return null;
      const parsed = parseScopeId(session.scopeId);
      const projectMembers = parsed.kind === "group" ? await deps.projects?.members(parsed.ref) : undefined;
      return deps.orchestrator.regenerateTitle(sessionId, principalId, projectMembers);
    },

    async forkSession(sessionId, principalId, opts) {
      if (!(await h.sessionForViewer(sessionId, principalId))) return null;
      const source = await deps.sessions.get(sessionId);
      if (!source) return null;
      const parsed = parseScopeId(source.scopeId);
      const fork = async (projectMembers?: readonly string[]) => {
        let visible = (await transcripts.forViewer(sessionId, principalId)).items;
        if (projectMembers?.length) {
          const views = await Promise.all(
            projectMembers.map(async (memberId) => (await transcripts.forViewer(sessionId, memberId)).items),
          );
          const seqSets = views.map((view) => new Set(view.map((entry) => entry.seq)));
          visible = visible.filter((entry) => seqSets.every((seqs) => seqs.has(entry.seq)));
        }
        const upToSeq = opts?.upToSeq;
        const copied = upToSeq === undefined ? visible : visible.filter((entry) => entry.seq <= upToSeq);
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const forked = await deps.sessions.getOrCreateByThread(
          threadRef,
          source.type,
          source.scopeId,
          source.channelName,
          "web",
        );
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(forked.id, memberId)),
        );
        const { lease } = await deps.sessions.acquireLease(forked.id, "fork");
        if (!lease) throw new Error(`fork: could not lease fresh session ${forked.id}`);
        let forkBoundarySeq: number | null;
        try {
          const copiedEntries = await deps.sessions.appendMany(
            lease,
            copied.map(({ sessionId: _s, seq: _q, createdAt: _c, targetSeq: _t, ...item }) => item as NewItem),
          );
          forkBoundarySeq = copiedEntries.at(-1)?.seq ?? null;
        } finally {
          await deps.sessions.releaseLease(lease);
        }
        if (forkBoundarySeq !== null) {
          await deps.sessions.updateForkProvenance(forked.id, {
            forkedFrom: { sessionId, title: source.title ?? null },
            forkBoundarySeq,
          });
        }
        const sourceTitle = source.title?.trim();
        if (sourceTitle && projectMembers === undefined)
          await deps.sessions.updateTitle(forked.id, `${sourceTitle} (fork)`);
        h.audit(principalId, "session.fork", sessionId, source.scopeId);
        const session = await continuable(principalId, (await deps.sessions.get(forked.id)) ?? forked);
        return { session, items: (await transcripts.forRender(forked.id)).items };
      };
      if (parsed.kind !== "group" || !projectIdFromGroupRef(parsed.ref)) return fork();
      return withProjectMembers(parsed.ref, principalId, (members) => fork(members));
    },

    async spawnSession(principalId, opts) {
      const scope = opts.scopeId;
      const parsed = parseScopeId(scope);
      const create = async (projectMembers?: readonly string[], channelName?: string) => {
        const threadRef = `web:${principalId}:${randomUUID()}`;
        const kind = parsed.kind === "group" || parsed.kind === "channel" ? parsed.kind : "dm";
        const session = await deps.sessions.getOrCreateByThread(threadRef, kind, scope, channelName, "web");
        await Promise.all(
          (projectMembers ?? [principalId]).map((memberId) => deps.sessions.addParticipant(session.id, memberId)),
        );
        if (opts.title?.trim()) await deps.sessions.updateTitle(session.id, opts.title.trim());
        h.audit(principalId, "session.spawn", session.id, scope);
        return { session: await continuable(principalId, (await deps.sessions.get(session.id)) ?? session) };
      };
      if (parsed.kind === "personal") {
        return parsed.ref === principalId ? create() : null;
      }
      if (parsed.kind === "group" && projectIdFromGroupRef(parsed.ref))
        return withProjectMembers(parsed.ref, principalId, (members, project) => create(members, project.name));
      if (!(await h.principalCanAccessCurrentScope(principalId, scope))) return null;
      return create();
    },

    async discardSession(sessionId, principalId) {
      const session = await h.sessionForViewer(sessionId, principalId);
      if (!session) return false;
      if (!(await deps.sessions.deleteSessionIfEmpty(sessionId))) return false;
      h.audit(principalId, "session.discard", sessionId, session.scopeId);
      return true;
    },

    async grant(g) {
      if (parseRef(g.ref).kind === "deploy") {
        g = {
          ...g,
          granteeScopeId: await deploymentShareScope(
            g.granteeScopeId,
            g.permission,
            async (email) =>
              deps.identity.isInternal(deps.identity.classify(email)) &&
              (await h.directoryMember(email))?.type === "internal",
          ),
        };
        await deps.deploy.assertShareAllowed(g.ownerScopeId, g.granteeScopeId, g.permission);
      }
      await deps.acl.grant(g, await h.artifactAuthor(g.ownerScopeId, g.ref));
      h.audit(g.grantedBy, "grant", g.ref, g.granteeScopeId);
      const ref = parseRef(g.ref);
      if (ref.kind === "deploy")
        await notifyDeploymentShared(
          deps,
          deps.deploy.getDeployment(ref.id),
          g.granteeScopeId,
          g.permission,
          g.grantedBy,
        );
    },
    async revokeGrant(ownerScopeId, ref, granteeScopeId, revokedBy) {
      await deps.acl.revoke(ownerScopeId, ref, granteeScopeId, revokedBy, await h.artifactAuthor(ownerScopeId, ref));
      h.audit(revokedBy, "revoke", ref, granteeScopeId);
    },
    async promoteSkill(id, targetScopeId, actorId, liveActor) {
      if (parseScopeId(targetScopeId).kind !== "org")
        throw new Error("promote targets the org scope — use share or move for anything narrower");
      if (liveActor !== true)
        throw new AdminError(403, "promoting a skill org-wide takes a live person, never an autonomous trigger");
      if (!deps.admin) throw new Error("org promotion requires an admin service");
      const status = await deps.admin.adminStatusOf({ id: actorId, type: "internal" });
      if (!status.isAdmin) throw new AdminError(403, "only an org admin can promote a skill org-wide");
      const promoted = await deps.skills.promote(id, targetScopeId);
      h.audit(actorId, "skill_promote", id, targetScopeId);
      return promoted;
    },

    belongsToScope: (principalId, scope) => h.principalCanAccessCurrentScope(principalId, scope),

    canManageArtifactHome: (homeScopeId, createdBy, principalId) =>
      h.principalManagesArtifactHome(homeScopeId, createdBy, principalId),

    artifactGrantPermission: (ownerScopeId, ref, principalId) =>
      h.artifactGrantPermission(ownerScopeId, ref, principalId),

    async getArtifactHome(type, idOrName): Promise<ArtifactHome | null> {
      const home = (a: { id: string; createdBy: string }, ownerScopeId: ScopeId, ref: ResourceRef) => ({
        id: a.id,
        ownerScopeId,
        createdBy: a.createdBy,
        grantRef: encodeRef(ref),
      });
      if (type === "skill") {
        const s = await deps.skills.get(idOrName);
        return s ? home(s, s.scopeId, skillRef(s.id)) : null;
      }
      if (type === "cron") {
        const c = await deps.crons.get(idOrName);
        return c ? home(c, c.ownerScopeId, cronRef(c.id)) : null;
      }
      if (type === "file") {
        const f = await deps.files.get(idOrName);
        return f ? home(f, f.ownerScopeId, fileRef(f.id)) : null;
      }
      const d = (await deps.deploy.listDeployments()).find((x) => x.id === idOrName || x.name === idOrName);
      return d ? home(d, d.ownerScopeId, deployRef(d.id)) : null;
    },

    async moveArtifactHome(type, id, toScope, movedBy) {
      if (type === "deploy") {
        await deps.deploy.transferDeploymentOwner(id, toScope, { callerId: movedBy });
        return;
      }
      if (type !== "skill") {
        throw new Error(`moving a ${type}'s home isn't supported — share it instead (add a grant)`);
      }
      await deps.skills.move(id, toScope);
      h.audit(movedBy, "skill_move", id, toScope);
    },

    getSoul(scopeIdValue) {
      const orgScopeId = tenant().orgScope;
      const orgSoul = deps.config.getSoul(orgScopeId);
      const soul = deps.config.getSoul(scopeIdValue);
      return {
        scopeId: scopeIdValue,
        soul,
        soulVersion: deps.config.soulVersion(scopeIdValue),
        orgScopeId,
        orgSoul,
        orgSoulVersion: deps.config.soulVersion(orgScopeId),
        effectiveSoul: composeSoul(orgSoul, scopeIdValue === orgScopeId ? null : soul),
      };
    },

    async updateSoul(scopeIdValue, content, actorId, opts) {
      const { kind, ref } = parseScopeId(scopeIdValue);
      const allowedPersonal = kind === "personal" && samePerson(ref, actorId);
      const allowedShared = opts?.allowSharedScope && (kind === "channel" || kind === "group");
      if (!allowedPersonal && !allowedShared) {
        throw new SoulUpdateDeniedError();
      }
      const write = async (): Promise<number> => {
        let snapshot: Awaited<ReturnType<typeof deps.config.captureSoulSnapshot>> | undefined;
        try {
          await deps.config.refreshScope(scopeIdValue);
          snapshot = await deps.config.captureSoulSnapshot(scopeIdValue);
          const version =
            opts?.expectedVersion === undefined
              ? await deps.config.setSoul(scopeIdValue, content, actorId)
              : await deps.config.setSoulIfVersion(scopeIdValue, opts.expectedVersion, content, actorId);
          if (version === null) throw new SoulVersionConflictError();
          h.audit(actorId, "soul_update", scopeIdValue, scopeIdValue);
          return version;
        } catch (error) {
          if (snapshot !== undefined) deps.config.restoreSoulCacheSnapshot(scopeIdValue, snapshot);
          if (opts?.expectedVersion !== undefined) await deps.config.refreshScope(scopeIdValue);
          throw error;
        }
      };
      return deps.advisoryLock.withLock(`admin-governance:${scopeIdValue}`, write);
    },
  } satisfies Partial<App>;
}
