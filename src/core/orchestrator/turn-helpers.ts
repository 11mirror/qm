import {
  type CandidateDestination,
  type CommandApprovalGrant,
  type Destination,
  type EgressPolicy,
  type Principal,
  type ScopeId,
  type TurnRequest,
  type ActorAssertion,
  turnSource,
} from "../../types.ts";
import { isOverheard, isReply, isUserMessage, type Item } from "../../sessions/items.ts";
import { forModelContext } from "../../harness/context-compaction.ts";
import type { SkillBundle, SkillBundleStore } from "../../skills/skill-bundle-store.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import { hostMatches } from "../../resolution/egress-policy.ts";
import { swallow } from "../../util/errors.ts";
import { hashId } from "../../util/crypto.ts";
import type { OrchestratorInput } from "./types.ts";

export function isScreenableTextAttachment(mimetype: string): boolean {
  const mime = mimetype.split(";", 1)[0]!.trim().toLowerCase();
  return (
    mime.startsWith("text/") ||
    [
      "application/json",
      "application/xml",
      "application/javascript",
      "application/yaml",
      "application/x-yaml",
    ].includes(mime)
  );
}

export function stripAckPrefix(text: string, ack: string | undefined): string {
  if (!text || !ack) return text;
  const lead = text.trimStart();
  if (!lead.startsWith(ack)) return text;
  return lead.slice(ack.length).trimStart();
}

export function headLooksLikeText(head: Buffer): boolean {
  if (head.length === 0) return true;
  if (head.includes(0)) return false;
  let suspicious = 0;
  for (const ch of head.toString("utf8")) {
    const c = ch.codePointAt(0)!;
    if (c === 0xfffd || (c < 0x20 && c !== 0x09 && c !== 0x0a && c !== 0x0d)) suspicious++;
  }
  return suspicious / head.length < 0.1;
}

const CONNECTOR_CAPABILITY = "connector:";

export function filterConnectorSkills(
  resolved: SkillResolution[],
  availableProviders: readonly string[],
): SkillResolution[] {
  const available = new Set(availableProviders);
  return resolved.filter((entry) =>
    (entry.skill?.manifest.requiredCapabilities ?? []).every(
      (capability) =>
        !capability.startsWith(CONNECTOR_CAPABILITY) || available.has(capability.slice(CONNECTOR_CAPABILITY.length)),
    ),
  );
}

export async function loadActiveBundles(store: SkillBundleStore, resolved: SkillResolution[]): Promise<SkillBundle[]> {
  const packIds = [...new Set(resolved.map((r) => r.skill?.pack?.packId).filter((id): id is string => Boolean(id)))];
  const bundles = await Promise.all(packIds.map((id) => store.get(id)));
  return bundles.filter((b): b is SkillBundle => b !== null);
}

export function egressClaimAllowingControlPlane(egress: EgressPolicy, apiBaseUrl: string): EgressPolicy {
  const allowedHosts = egress.allowedHosts ?? [];
  const deniedHosts = egress.deniedHosts ?? [];
  let coreHost = "";
  if (apiBaseUrl) {
    try {
      coreHost = new URL(apiBaseUrl).hostname;
    } catch (e) {
      swallow("orchestrator: apiBaseUrl parse", e);
    }
  }
  const safeDenied = coreHost ? deniedHosts.filter((d) => !hostMatches(coreHost, d)) : deniedHosts;
  const allowedWithCore =
    coreHost && allowedHosts.length > 0 && !allowedHosts.includes(coreHost)
      ? [...allowedHosts, coreHost]
      : allowedHosts;
  return {
    allowedHosts: allowedWithCore,
    denyPrivateNetworks: true,
    ...(coreHost ? { privateNetworkAllowedHosts: [coreHost] } : {}),
    ...(safeDenied.length ? { deniedHosts: safeDenied } : {}),
  };
}

export function stripTurnBoilerplate(text: string): string {
  const kept = text
    .split("\n\n")
    .filter((p) => !/^\s*\[/.test(p))
    .join("\n\n")
    .trim();
  return kept || text.trim();
}

export function visibleTitleItemText(item: Item): string | undefined {
  const value = isUserMessage(item) && typeof item.body.display === "string" ? item.body.display : item.text;
  return typeof value === "string" ? value.trim() || undefined : undefined;
}

export function renderTitleTranscript(entries: Item[]): string {
  const lines: string[] = [];
  for (const e of forModelContext([...entries])) {
    const user = isUserMessage(e);
    if (!user && !isReply(e)) continue;
    if (isOverheard(e)) continue;
    const raw = visibleTitleItemText(e);
    if (!raw) continue;
    const text = user ? stripTurnBoilerplate(raw) : raw;
    if (!text) continue;
    lines.push(`${user ? "User" : "Assistant"}:\n${text}`);
  }
  return lines.join("\n\n");
}

function principalAssertion(p: Principal): ActorAssertion {
  return {
    externalId: p.id,
    ...(p.type === "guest" ? { isExternalGuest: true } : {}),
    ...(p.teamIds ? { teamIds: p.teamIds } : {}),
    ...(p.displayName ? { displayName: p.displayName } : {}),
  };
}

export function replayableRequest(input: OrchestratorInput): TurnRequest {
  const {
    modelAccount: _modelAccount,
    surface,
    privateSessionMessage,
    sessionMessageDepth,
    actor,
    conversation: c,
    origin,
    runId: _runId,
    attempt: _attempt,
    resumeCause: _resumeCause,
    runLeaseToken: _runLeaseToken,
    turnFenceToken: _turnFenceToken,
    runStartedAt: _runStartedAt,
    finalAttempt: _finalAttempt,
    cancel: _cancel,
    shutdown: _shutdown,
    sessionParticipantIds: _sessionParticipantIds,
    wakeCause: _wakeCause,
    trace: _trace,
    approval: _approval,
    slackSource: _slackSource,
    source: _source,
    ...request
  } = input;
  const source = turnSource(input);
  return {
    ...request,
    surface: surface ?? "unknown",
    ...(source ? { source } : {}),
    actor: principalAssertion(actor),
    conversation: {
      kind: c.kind,
      threadRef: c.threadRef,
      ...(c.channelRef ? { channelRef: c.channelRef } : {}),
      ...(c.channelName ? { channelName: c.channelName } : {}),
      audience: c.audience.map(principalAssertion),
      ...(c.isPrivate !== undefined ? { isPrivate: c.isPrivate } : {}),
      ...(c.isMpim !== undefined ? { isMpim: c.isMpim } : {}),
      ...(c.publishMembers ? { publishMembers: c.publishMembers.map(principalAssertion) } : {}),
    },
    origin,
    ...(privateSessionMessage ? { privateSessionMessage: true as const, sessionMessageDepth } : {}),
  };
}

export function approvalGrantId(
  grant: Pick<CommandApprovalGrant, "actorId" | "command" | "scope" | "sessionId" | "approvalKey">,
): string {
  return hashId([grant.actorId, grant.scope, grant.sessionId ?? "*", grant.approvalKey ?? grant.command], 24);
}

function candidateKey(target: string, audienceScopeId: ScopeId): string {
  return hashId([target, audienceScopeId]);
}

const SURFACE_ENQUEUE_ACTIONS = new Set(["post", "reach", "react", "edit", "delete"]);

export function completedSurfaceEnqueues(entries: readonly Item[], sinceSeq: number, surfaceTool: string): number {
  const later = entries.filter((e) => e.seq > sinceSeq);
  const answered = new Set(
    later.flatMap((e) => (e.kind === "ToolResult" && e.body.interrupted !== true ? [e.callId] : [])),
  );
  return later.filter(
    (e) =>
      e.kind === "ToolCall" &&
      e.tool === surfaceTool &&
      SURFACE_ENQUEUE_ACTIONS.has(String(e.body.action)) &&
      answered.has(e.callId),
  ).length;
}

export interface TurnPostKeys {
  seed(completed: number): void;
  take(): number;
  key(destination: Destination, seq: number): string;
}

export function turnPostKeys(turnKey: string): TurnPostKeys {
  let next = 0;
  return {
    seed(completed) {
      next = completed;
    },
    take: () => next++,
    key: (destination, seq) => `post:${turnKey}:${destination.type}:${destination.target}:${seq}`,
  };
}

export function replaceThreadSegment(target: string, threadTs: string): string {
  const i = target.lastIndexOf(":");
  const channel = i < 0 ? target : target.slice(0, i);
  return `${channel}:${threadTs}`;
}

export function deliveryCandidatesFor(
  surface: string | undefined,
  deliveryTarget: string | undefined,
  surfaceCandidates: { target: string; label: string }[] | undefined,
  sessionScopeId: ScopeId,
): { candidates: CandidateDestination[]; defaultKey?: string } {
  if (!surface) return { candidates: [] };
  let raw: { target: string; label: string }[] = [];
  if (surfaceCandidates && surfaceCandidates.length > 0) raw = surfaceCandidates;
  else if (deliveryTarget) raw = [{ target: deliveryTarget, label: "this conversation" }];
  const seen = new Set<string>();
  const candidates: CandidateDestination[] = [];
  for (const c of raw) {
    const key = candidateKey(c.target, sessionScopeId);
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({ type: surface, target: c.target, audienceScopeId: sessionScopeId, key, label: c.label });
  }
  const defaultKey = candidates.find((c) => c.target === deliveryTarget)?.key ?? candidates[0]?.key;
  return { candidates, ...(defaultKey ? { defaultKey } : {}) };
}
