import {
  type CandidateDestination,
  type Destination,
  type EgressPolicy,
  type Principal,
  type ScopeId,
  type TurnRequest,
  type ActorAssertion,
  turnSource,
} from "../../types.ts";
import type { SkillBundle, SkillBundleStore } from "../../skills/skill-bundle-store.ts";
import type { SkillResolution } from "../../skills/skill-store.ts";
import { hostMatches } from "../../resolution/egress-policy.ts";
import { swallow, swallowAs } from "../../util/errors.ts";
import { estimateCostUsd } from "../../ratelimit/budget.ts";
import { hashId } from "../../util/crypto.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export function stripAckPrefix(text: string, ack: string | undefined): string {
  if (!text || !ack) return text;
  const lead = text.trimStart();
  if (!lead.startsWith(ack)) return text;
  return lead.slice(ack.length).trimStart();
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
    background: _background,
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

function candidateKey(target: string, audienceScopeId: ScopeId): string {
  return hashId([target, audienceScopeId]);
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

export function modelCallRecorder(
  deps: Pick<OrchestratorDeps, "modelGateway" | "budget">,
  scopeLabel: ScopeId,
  actorId: string,
): (rec: { model: string; inputTokens: number; entryCount: number }) => void {
  return (rec) => {
    deps.modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
    void deps.budget
      ?.record(actorId, estimateCostUsd(rec.inputTokens))
      .catch(swallowAs("budget: record model spend", undefined));
  };
}
