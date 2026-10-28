import type { Readable } from "node:stream";
import { isSessionTurn } from "../turn-origin.ts";
import type {
  Conversation,
  DeliveryProvenance,
  Destination,
  OutgoingAttachment,
  Principal,
  ScopeId,
  Session,
  SurfaceContextQuery,
} from "../../types.ts";
import {
  openGroupViaSurface,
  reachPost,
  resolveReachTarget,
  withReact,
  withEdit,
  withDelete,
  type ReachResolution,
} from "../../reach/reach.ts";
import { type SandboxHandle } from "../../sandbox/sandbox.ts";
import type {
  SurfaceToolDeps,
  SurfacePostResult,
  SurfaceReactInput,
  SurfaceEditInput,
  SurfaceDeleteInput,
  SurfaceSearchResult,
} from "../../tools/primitives.ts";
import { isBlobId, type BlobTransferStore } from "../../persistence/blob-transfer.ts";
import {
  collectNamedOutbound,
  parseOutboundFiles,
  type OutboundFile,
  type OpenStoredFile,
  type ArtifactRegistration,
} from "../attachments.ts";
import { parseBotLedger, type BotPolicy, type ChannelPolicy } from "../../surface-cache/channel-policy-store.ts";
import { isoFromTs } from "../../util/message-tag.ts";
import { errMessage, swallowAs } from "../../util/errors.ts";
import { headLooksLikeText, replaceThreadSegment, type TurnPostKeys } from "./turn-helpers.ts";
import type { OrchestratorDeps, OrchestratorInput, SurfaceContextPuller } from "./types.ts";
import { fileMetas, unattachable } from "./attach-tool.ts";
import { parseDeliveryTarget } from "../../slack/delivery.ts";
import { RECENT_THREAD_LIMIT } from "../../slack/conversation-view.ts";
import { parseFileRef } from "../../surfaces/refs.ts";
import { bareChannelName } from "../../util/text.ts";

const SURFACE_SEARCH_DEFAULT = 10;
const SURFACE_FILE_PAGE_CHARS = 20_000;
const SLACK_CONVERSATIONS_HISTORY_TIER3_PER_MINUTE = 50;
const HISTORY_PAGES_PER_CALL = SLACK_CONVERSATIONS_HISTORY_TIER3_PER_MINUTE / 5;

interface PulledPages {
  messages: unknown[];
  selfTs: string[];
  note?: string;
  exhausted: boolean;
}

async function pullPages(
  puller: SurfaceContextPuller,
  source: string,
  query: SurfaceContextQuery,
  signal: AbortSignal,
  done: (messages: unknown[]) => boolean,
): Promise<PulledPages | null> {
  const messages: unknown[] = [];
  const selfTs: string[] = [];
  const notes = new Set<string>();
  let before: string | undefined;
  let exhausted = false;
  for (let pages = 0; pages < HISTORY_PAGES_PER_CALL; pages++) {
    const page = await puller.pull(source, before ? { ...query, before } : query);
    if (!page) {
      if (pages === 0) return null;
      break;
    }
    messages.push(...page.messages);
    selfTs.push(...(page.selfTs ?? []));
    if (page.note) notes.add(page.note);
    const advanced = page.nextBefore !== undefined && page.nextBefore !== before;
    const failed = Boolean(page.note) && !page.messages.length && !advanced;
    exhausted = !failed && !page.hasMore;
    if (failed || exhausted || !advanced || signal.aborted || done(messages)) break;
    before = page.nextBefore;
  }
  const note = [...notes].join(" ");
  return { messages, selfTs, ...(note ? { note } : {}), exhausted };
}

export interface SpineState {
  surfaceOutboundCount: number;
  turnUserEntrySeq: number | undefined;
}

export interface SurfaceToolsContext {
  deps: OrchestratorDeps;
  input: OrchestratorInput;
  actor: Principal;
  conversation: Conversation;
  session: Session;
  scopeId: ScopeId;
  strictReadOnly: boolean;
  defaultDestination: Destination | undefined;
  blobTransfer: BlobTransferStore;
  fileRegistration: ArtifactRegistration;
  openStored?: OpenStoredFile;
  provision: (sandboxId?: string) => Promise<SandboxHandle>;
  postProvenance: (deliveryKey: string) => DeliveryProvenance;
  postKeys: TurnPostKeys;
  spine: SpineState;
  signal: AbortSignal;
}

type SurfaceTurn = SurfaceToolsContext & {
  here: Destination;
  outbound: NonNullable<OrchestratorDeps["outbound"]>;
  rateLimitRecipient: { rateLimitRecipient?: { target: string; user: string } };
};

export function createSurfaceToolDeps(ctx: SurfaceToolsContext): SurfaceToolDeps | undefined {
  const { deps, input, actor, strictReadOnly, defaultDestination } = ctx;
  if (strictReadOnly || !(input.surfaceTools && defaultDestination && deps.outbound)) return undefined;
  const turn: SurfaceTurn = {
    ...ctx,
    here: defaultDestination,
    outbound: deps.outbound,
    rateLimitRecipient:
      input.origin?.kind === "human" &&
      !isSessionTurn(input) &&
      defaultDestination.type === "slack" &&
      defaultDestination.target
        ? { rateLimitRecipient: { target: defaultDestination.target, user: actor.id } }
        : {},
  };
  const coverageForTurn = surfaceCoverage(turn);
  return {
    ...postingTools(turn),
    ...readingTools(turn, coverageForTurn),
    ...searchTool(turn, coverageForTurn),
    ...channelTools(turn),
  };
}

function destinationTools(turn: SurfaceTurn) {
  const {
    deps,
    input,
    actor,
    conversation,
    blobTransfer,
    fileRegistration,
    provision,
    postProvenance,
    postKeys,
    spine,
    outbound,
    here: currentDestination,
  } = turn;
  const resolveDestination = async (
    target?: {
      channel?: string;
      recipient?: string;
      participants?: readonly string[];
    },
    opts?: { mayOpenGroup?: boolean },
  ): Promise<{ ok: true; destination: Destination } | { ok: false; message: string }> => {
    if (
      !target ||
      (target.channel === undefined && target.recipient === undefined && target.participants === undefined)
    ) {
      return { ok: true, destination: currentDestination };
    }
    if (
      target.channel !== undefined &&
      conversation.channelRef &&
      (target.channel === conversation.channelRef ||
        bareChannelName(target.channel).toLowerCase() === conversation.channelName?.toLowerCase())
    ) {
      return { ok: true, destination: { ...currentDestination, target: conversation.channelRef } };
    }
    if (!deps.directory)
      return { ok: false, message: "I can't reach a named channel or teammate from here — no directory is available." };
    const r: ReachResolution = await resolveReachTarget(
      {
        resolveRecipient: (q) => deps.directory!.resolve(q),
        resolveChannel: (q) => deps.directory!.resolveChannel(q),
        channelMember: (c, p) => deps.directory!.channelMember(c, p),
        resolveGroup: (parts) => deps.directory!.resolveGroupByParticipants(parts),
        groupMember: (g, p) => deps.directory!.groupMember(g, p),
        directoryMember: (p) => deps.directory!.get(p),
        ...(deps.surfaceContext
          ? {
              openGroup: (parts: readonly string[]) =>
                openGroupViaSurface((query) => deps.surfaceContext!.pull("slack", query), parts),
              registerGroup: (g: string, parts: readonly string[]) => deps.directory!.upsertGroup(g, parts),
            }
          : {}),
      },
      {
        ...(target.channel !== undefined ? { channel: target.channel } : {}),
        ...(target.recipient !== undefined ? { recipient: target.recipient } : {}),
        ...(target.participants !== undefined ? { participants: target.participants } : {}),
      },
      actor.id,
      { mayOpenGroup: opts?.mayOpenGroup === true },
    );
    if (!r.ok) return { ok: false, message: r.message };
    return { ok: true, destination: r.destination };
  };
  const enqueue = async (
    destination: Destination,
    postText: string,
    seq: number,
    attachments?: OutgoingAttachment[],
  ): Promise<SurfacePostResult> => {
    try {
      const idempotencyKey = postKeys.key(destination, seq);
      await reachPost({
        outbound,
        destination,
        text: postText,
        ...(attachments?.length ? { attachments } : {}),
        idempotencyKey,
        provenance: postProvenance(idempotencyKey),
      });
      spine.surfaceOutboundCount += 1;
      if (input.runId) deps.turnStream?.markSurfacePosted(input.runId);
      return { ok: true };
    } catch (e) {
      return { ok: false, message: errMessage(e) };
    }
  };
  const resolveFiles = async (
    files?: readonly OutboundFile[],
    sandboxId?: string,
  ): Promise<{ ok: true; attachments?: OutgoingAttachment[] } | { ok: false; message: string }> => {
    if (!files?.length) return { ok: true };
    const parsed = parseOutboundFiles(files);
    if (!parsed.ok) return parsed;
    const r = await collectNamedOutbound(
      deps.sandbox,
      () => provision(sandboxId),
      files,
      blobTransfer,
      fileRegistration,
      [],
      turn.openStored,
    );
    const bad = unattachable(r);
    if (bad.length)
      return { ok: false, message: `couldn't attach: ${bad.join(", ")} — nothing was sent; fix the path(s) and retry` };
    return { ok: true, attachments: r.attachments };
  };
  return { resolveDestination, enqueue, resolveFiles };
}

const targetOf = (input: { channel?: string; participants?: readonly string[] }) => ({
  ...(input.channel !== undefined ? { channel: input.channel } : {}),
  ...(input.participants !== undefined ? { participants: input.participants } : {}),
});

function postingTools(turn: SurfaceTurn): Pick<SurfaceToolDeps, "post" | "reach" | "react" | "edit" | "delete"> {
  const { deps, input, conversation, postKeys, here: currentDestination } = turn;
  const { resolveDestination, enqueue, resolveFiles } = destinationTools(turn);
  let editRefConsumed = false;
  return {
    post: async (postText, opts, files, sandboxId) => {
      const seq = postKeys.take();
      let destination = currentDestination;
      if (opts?.ts && destination.type !== "principal") {
        destination = { ...destination, target: replaceThreadSegment(destination.target, opts.ts) };
      } else if (opts?.broadcast && destination.type !== "principal" && conversation.channelRef) {
        destination = { ...destination, target: conversation.channelRef };
      }
      const f = await resolveFiles(files, sandboxId);
      if (!f.ok) return { ok: false, message: f.message };
      const run = input.runId ? await deps.runs?.get(input.runId) : null;
      const editRef =
        !editRefConsumed && destination.target === currentDestination.target ? run?.deliveryState?.editRef : undefined;
      if (editRef) editRefConsumed = true;
      const projectedDestination = {
        ...destination,
        ...(editRef ? { editRef } : {}),
      };
      const sent = await enqueue(projectedDestination, postText, seq, f.attachments);
      return sent.ok && f.attachments?.length ? { ...sent, attachments: fileMetas(f.attachments) } : sent;
    },
    reach: async (postText, target, files, sandboxId) => {
      const seq = postKeys.take();
      const selectors = [
        target.channel !== undefined,
        target.recipient !== undefined,
        target.participants !== undefined,
      ].filter(Boolean).length;
      if (selectors !== 1)
        return { ok: false, message: "reach needs exactly one of: channel, recipient, or participants." };
      const f = await resolveFiles(files, sandboxId);
      if (!f.ok) return { ok: false, message: f.message };
      const sending = postText.trim().length > 0 || (f.attachments?.length ?? 0) > 0;
      const d = await resolveDestination(target, { mayOpenGroup: sending });
      if (!d.ok) return { ok: false, message: d.message };
      const r0 = await enqueue(d.destination, postText, seq, f.attachments);
      if (!r0.ok) return r0;
      const r = f.attachments?.length ? { ...r0, attachments: fileMetas(f.attachments) } : r0;
      let label = `a group DM (${target.participants?.length ?? 0} people)`;
      if (target.channel !== undefined) label = `#${bareChannelName(target.channel)}`;
      else if (target.recipient !== undefined) label = `a DM to ${target.recipient}`;
      return { ...r, matched: label };
    },
    react: async (input: SurfaceReactInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination(targetOf(input));
      if (!d.ok) return { ok: false, message: d.message };
      if (d.destination.type === "principal")
        return { ok: false, message: "I can only react to a message in a channel, group DM, or this conversation." };
      return enqueue(withReact(d.destination, { messageTs: input.ts, emoji: input.emoji }), "", seq);
    },
    edit: async (input: SurfaceEditInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination(targetOf(input));
      if (!d.ok) return { ok: false, message: d.message };
      return enqueue(withEdit(d.destination, input.ref), input.text, seq);
    },
    delete: async (input: SurfaceDeleteInput) => {
      const seq = postKeys.take();
      const d = await resolveDestination(targetOf(input));
      if (!d.ok) return { ok: false, message: d.message };
      return enqueue(withDelete(d.destination, { messageTs: input.ref }), "", seq);
    },
  };
}

function surfaceCoverage(turn: SurfaceTurn): () => Promise<string | undefined> {
  const { deps, conversation, here: currentDestination } = turn;
  let coverageChecked = false;
  let coverageSince: string | undefined;
  const coverageForTurn = async (): Promise<string | undefined> => {
    if (coverageChecked) return coverageSince;
    coverageChecked = true;
    const container = currentDestination.target ?? conversation.channelRef ?? conversation.threadRef;
    if (!deps.surfaceCache || !container) return coverageSince;
    const cacheContainer = currentDestination.type === "slack" ? parseDeliveryTarget(container).channel : container;
    const st = await deps.surfaceCache
      .containerState(cacheContainer)
      .catch(swallowAs("surface cache: container coverage", null));
    coverageSince = st?.oldestTs ? isoFromTs(st.oldestTs) || undefined : undefined;
    return coverageSince;
  };
  return coverageForTurn;
}

const TEXT_SNIFF_BYTES = 8000;

async function readTextPage(stream: Readable, offset: number): Promise<string | null> {
  const wanted = offset + SURFACE_FILE_PAGE_CHARS;
  const decoder = new TextDecoder();
  const head: Buffer[] = [];
  let headBytes = 0;
  let text = "";
  for await (const chunk of stream as AsyncIterable<Buffer>) {
    if (headBytes < TEXT_SNIFF_BYTES) {
      head.push(chunk);
      headBytes += chunk.length;
      if (headBytes >= TEXT_SNIFF_BYTES && !headLooksLikeText(Buffer.concat(head).subarray(0, TEXT_SNIFF_BYTES))) {
        stream.destroy();
        return null;
      }
    }
    text += decoder.decode(chunk, { stream: true });
    if (text.length > wanted) {
      stream.destroy();
      return text;
    }
  }
  if (headBytes < TEXT_SNIFF_BYTES && !headLooksLikeText(Buffer.concat(head))) return null;
  return text + decoder.decode();
}

function readingTools(
  turn: SurfaceTurn,
  coverageForTurn: () => Promise<string | undefined>,
): Pick<SurfaceToolDeps, "readThread" | "whatsNew" | "readMembers" | "readFile"> {
  const { deps, input, actor, conversation, blobTransfer, here: currentDestination, rateLimitRecipient, signal } = turn;
  const stagedFileId = async (ref: string): Promise<{ id: string } | { message: string }> => {
    if (isBlobId(ref)) return { id: ref };
    const fileRef = parseFileRef(ref);
    if (!fileRef)
      return {
        message: "that doesn't look like a file I can read — pass the [ref …] shown next to the file in a read.",
      };
    if (!deps.surfaceContext || !currentDestination.target)
      return { message: "the surface can't be read from this turn" };
    if (parseDeliveryTarget(currentDestination.target).channel !== fileRef.channel)
      return {
        message: `that file is in another conversation — fetch it with POST /v1/surface-file {"ref": "${ref}"}`,
      };
    const { channel: _channel, ...file } = fileRef;
    const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
      conversationTarget: currentDestination.target,
      viewer: actor.id,
      ...rateLimitRecipient,
      count: 1,
      file,
    });
    if (!result) return { message: "the surface didn't answer in time" };
    return result.file ? { id: result.file.blobId } : { message: result.note ?? "I can't find that file." };
  };
  return {
    readThread: async (opts?: { limit?: number }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      if (!currentDestination.target) return { ok: false, message: "this conversation has no thread to read" };
      const result = await deps.surfaceContext.pull(input.surface ?? "unknown", {
        conversationTarget: currentDestination.target,
        viewer: actor.id,
        ...rateLimitRecipient,
        ...(opts?.limit !== undefined ? { count: opts.limit } : {}),
      });
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages?.length) return { ok: false, message: result.note };
      return { ok: true, messages: result.messages, ...(result.note ? { message: result.note } : {}) };
    },
    whatsNew: async (opts?: { since?: string }) => {
      if (!deps.surfaceContext) return { ok: false, message: "the surface can't be read from this turn" };
      const dest = currentDestination;
      if (!dest.target) return { ok: false, message: "this conversation has nothing to check" };
      const since = opts?.since;
      const reachedSince = (messages: unknown[]) =>
        since === undefined ||
        (messages as Array<{ ts?: string }>).some((m) => typeof m?.ts === "string" && m.ts <= since);
      const result = await pullPages(
        deps.surfaceContext,
        input.surface ?? "unknown",
        { conversationTarget: dest.target, viewer: actor.id, ...rateLimitRecipient, count: RECENT_THREAD_LIMIT },
        signal,
        reachedSince,
      );
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages.length) return { ok: false, message: result.note };
      const msgs = result.messages as Array<{ ts?: string; threadTs?: string }>;
      const self = new Set(result.selfTs);
      const newer = msgs.filter(
        (m) => typeof m?.ts === "string" && (since === undefined || m.ts > since) && !self.has(m.ts),
      );
      const isDm = conversation.kind === "dm";
      const hereRoot = dest.target.slice(dest.target.lastIndexOf(":") + 1);
      const otherRoots = new Set<string>();
      let hereNew = 0;
      for (const m of newer) {
        if (isDm || m.threadTs === hereRoot || m.ts === hereRoot) hereNew++;
        else if (m.threadTs) otherRoots.add(m.threadTs);
      }
      const latest = msgs.reduce<string | undefined>(
        (acc, m) => (typeof m?.ts === "string" && (!acc || m.ts > acc) ? m.ts : acc),
        undefined,
      );
      const coverage = await coverageForTurn();
      const complete = result.exhausted || (since !== undefined && reachedSince(msgs));
      const capped = complete ? undefined : `Counts cover only the newest ${msgs.length} messages.`;
      const message = [result.note, capped].filter(Boolean).join(" ");
      return {
        ok: true,
        hereNew,
        activeSubConversations: otherRoots.size,
        ...(message ? { message } : {}),
        ...(latest ? { latest } : {}),
        ...(coverage ? { coverageSince: coverage } : {}),
      };
    },
    readMembers: async () => {
      const roster = (conversation.publishMembers ?? conversation.audience).filter((p) => p.type === "internal");
      if (!roster.length) return { ok: true, members: [] };
      return { ok: true, members: roster.map((p) => ({ displayName: p.displayName ?? p.id })) };
    },
    readFile: async (ref: string, offset = 0) => {
      const staged = await stagedFileId(ref.trim());
      if ("message" in staged) return { ok: false, message: staged.message };
      const id = staged.id;
      let blob;
      try {
        blob = await blobTransfer.open(id);
      } catch (e) {
        return { ok: false, message: errMessage(e) };
      }
      if (!blob) return { ok: false, message: "I can't find that file — it may have expired." };
      const page = await readTextPage(blob.stream, offset);
      if (page === null) return { ok: true, sizeBytes: blob.sizeBytes, contentType: "application/octet-stream" };
      const start = Math.max(0, Math.min(offset, page.length));
      const end = Math.min(page.length, start + SURFACE_FILE_PAGE_CHARS);
      return {
        ok: true,
        content: page.slice(start, end),
        sizeBytes: blob.sizeBytes,
        ...(end < page.length ? { nextOffset: end } : {}),
      };
    },
  };
}

function searchTool(
  turn: SurfaceTurn,
  coverageForTurn: () => Promise<string | undefined>,
): Pick<SurfaceToolDeps, "search"> {
  const { deps, input, actor, conversation, here: currentDestination, rateLimitRecipient, signal } = turn;
  return {
    search: async (query: string, opts?: { limit?: number; source?: "mirror" | "slack" }) => {
      const q = query.trim();
      const coverage = await coverageForTurn();
      const withCoverage = (r: SurfaceSearchResult): SurfaceSearchResult =>
        coverage ? { ...r, coverageSince: coverage } : r;
      if (!q) return withCoverage({ ok: true, hits: [], source: "cache" });
      const limit = Math.max(1, opts?.limit ?? SURFACE_SEARCH_DEFAULT);
      const dest = currentDestination;
      const matching = (messages: unknown[], prefiltered = false) =>
        (messages as Array<{ ts?: string; time?: string; author?: string; text?: string }>).filter(
          (m) => typeof m?.text === "string" && (prefiltered || m.text.toLowerCase().includes(q.toLowerCase())),
        );
      const shapeHits = (messages: unknown[], prefiltered = false) =>
        matching(messages, prefiltered)
          .slice(-limit)
          .map((m) => ({
            ...(m.ts ? { ref: m.ts } : {}),
            ...(m.author ? { author: m.author } : {}),
            ...(m.time ? { when: m.time } : {}),
            snippet: String(m.text),
          }));
      if (opts?.source === "slack") {
        if (!deps.surfaceContext?.searchLive)
          return { ok: false, message: "live search isn't available from this turn" };
        if (!dest.target) return { ok: false, message: "this conversation has nothing to search" };
        const result = await deps.surfaceContext.searchLive(input.surface ?? "unknown", {
          conversationTarget: dest.target,
          viewer: actor.id,
          ...rateLimitRecipient,
          count: limit,
          searchAll: q,
        });
        if (!result) return { ok: false, message: "the surface didn't answer in time" };
        if (result.liveSearch === "unconfigured") return { ok: false, message: "[live search isn't configured]" };
        if (result.liveSearch === "unconnected")
          return {
            ok: false,
            message:
              "[live search runs as the asking person's own Slack login, and this turn has no connected one. " +
              "Reading this conversation's history needs no personal login, so read it before concluding anything is missing; " +
              "only if the message is elsewhere, and a person asked, point them at " +
              (deps.publicWebUrl ? `${deps.publicWebUrl}/connect/slack/self-connect` : "the web UI's Connectors page") +
              " to connect their Slack (signing in there identifies them; no link needs minting) " +
              "instead of concluding the message doesn't exist; " +
              "on an autonomous turn just say what you couldn't search]",
          };
        if (result.note && !result.messages?.length) return { ok: false, message: result.note };
        return withCoverage({
          ok: true,
          hits: shapeHits(result.messages ?? [], true),
          source: "slack",
          ...(result.note ? { message: result.note } : {}),
        });
      }
      const container = dest.target ?? conversation.channelRef ?? conversation.threadRef;
      if (deps.surfaceCache && dest.type === "slack" && container) {
        const hits = await deps.surfaceCache.search(q, { container: parseDeliveryTarget(container).channel, limit });
        return withCoverage({
          ok: true,
          hits: hits.map((hit) => ({
            ref: hit.ts,
            ...(hit.authorName ? { author: hit.authorName } : {}),
            when: isoFromTs(hit.ts),
            snippet: hit.text,
          })),
          source: "cache",
          message: "Search covers stored Slack events only; older or missed messages may be absent.",
        });
      }
      if (opts?.source === "mirror") {
        return { ok: false, message: "Stored Slack message search is unavailable; no live search was performed." };
      }
      if (!deps.surfaceContext) return { ok: false, message: "search isn't available from this turn" };
      if (!dest.target) return { ok: false, message: "this conversation has nothing to search" };
      const result = await pullPages(
        deps.surfaceContext,
        input.surface ?? "unknown",
        {
          conversationTarget: dest.target,
          viewer: actor.id,
          ...rateLimitRecipient,
          count: RECENT_THREAD_LIMIT,
        },
        signal,
        (messages) => matching(messages).length >= limit,
      );
      if (!result) return { ok: false, message: "the surface didn't answer in time" };
      if (result.note && !result.messages.length) return { ok: false, message: result.note };
      const scanned = result.messages;
      const capped = result.exhausted ? undefined : `Searched only the newest ${scanned.length} messages.`;
      const message = [result.note, capped].filter(Boolean).join(" ");
      return withCoverage({
        ok: true,
        hits: shapeHits(scanned),
        source: "live",
        ...(message ? { message } : {}),
      });
    },
  };
}

function channelTools(turn: SurfaceTurn): Pick<SurfaceToolDeps, "getChannelBehavior" | "setChannelBehavior"> {
  const { deps, actor, conversation, session, scopeId } = turn;
  return {
    getChannelBehavior: async () => {
      if (!deps.channelPolicy) return { ok: false, message: "channel settings aren't available on this turn" };
      if (conversation.kind === "dm" || !conversation.channelRef)
        return { ok: false, message: "channel settings apply only inside a channel." };
      const p = await deps.channelPolicy.get(conversation.channelRef);
      return {
        ok: true,
        ...(p?.bots && Object.keys(p.bots).length ? { bots: p.bots } : {}),
        ...(p?.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
      };
    },
    setChannelBehavior: async (bots?: Record<string, BotPolicy>, ambientEnabled?: boolean | null) => {
      if (!deps.channelPolicy) return { ok: false, message: "channel settings aren't available on this turn" };
      if (conversation.kind === "dm" || !conversation.channelRef)
        return { ok: false, message: "channel settings apply only inside a channel." };
      let parsedBots: Record<string, BotPolicy> | undefined;
      if (bots !== undefined) {
        const parsed = parseBotLedger(bots);
        if ("error" in parsed) return { ok: false, message: parsed.error };
        parsedBots = parsed.bots;
      }
      let p: ChannelPolicy;
      try {
        p = await deps.channelPolicy.set(conversation.channelRef, {
          setBy: actor.id,
          bots: parsedBots,
          sessionId: session.id,
          ambientEnabled,
        });
      } catch (error) {
        return { ok: false, message: errMessage(error) };
      }
      deps.auditLog.record({
        at: Date.now(),
        principalId: actor.id,
        action: "surface.policy.set",
        resource: conversation.channelRef,
        scopeLabel: scopeId,
      });
      return {
        ok: true,
        ...(p.bots && Object.keys(p.bots).length ? { bots: p.bots } : {}),
        ...(p.ambientEnabled !== undefined ? { ambientEnabled: p.ambientEnabled } : {}),
      };
    },
  };
}
