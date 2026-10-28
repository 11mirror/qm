import type { FeatureName } from "../../feature-flags.ts";
import { surfaceHas } from "../../surfaces/surface.ts";
import { scopeTeamsToTurn } from "../../teams/teams.ts";
import { externalSlackAdmitted } from "../../resolution/external-slack.ts";
import { delegatedAuthorizationOrigin } from "../../subagents/delegation.ts";
import { isSubagentThreadRef } from "../../sessions/thread-ref.ts";
import { createCanWriteScope, rosterAdmits } from "../../resolution/scope-membership.ts";
import { isValidTimezone } from "../../util/time.ts";
import { isSessionTurn } from "../turn-origin.ts";
import { scopeId as toScopeId, type ScopeId, type TurnResult } from "../../types.ts";
import { swallowAs } from "../../util/errors.ts";
import { tenant } from "../../tenant.ts";
import type { Session } from "../../types.ts";
import type { OrchestratorDeps, OrchestratorInput } from "./types.ts";

export class ProjectRosterChanged extends Error {}

export function rosterChangedRefusal(sessionId?: string): TurnResult {
  return {
    status: "refused",
    ...(sessionId !== undefined ? { sessionId } : {}),
    reason: "project membership changed; retry from the current project",
  };
}

export interface AdmittedTurn {
  input: OrchestratorInput;
  actor: OrchestratorInput["actor"];
  conversation: OrchestratorInput["conversation"];
  external: boolean;
  serviceAllowed: (slug: string) => boolean;
  automatedTurn: boolean;
  ambientTurn: boolean;
  sessionTurn: boolean;
  humanInput: boolean;
  allInternal: boolean;
  actorFeatures: ReadonlySet<FeatureName>;
  delegationEnabled: boolean;
  authorizationOrigin: OrchestratorInput["origin"];
  liveTurn: boolean;
  liveAuthorTurn: boolean;
  messageTs: string | undefined;
  entryTs: string | undefined;
  coreReceivedAt: number;
  turnTimezone: string | undefined;
  delegatedSession: Session | null;
  withManagedRosterVersion: <T>(fn: () => Promise<T>) => Promise<T>;
}

export async function admitTurn(
  deps: OrchestratorDeps,
  requested: OrchestratorInput,
): Promise<{ admitted: AdmittedTurn } | { refused: TurnResult }> {
  if (
    !(await externalSlackAdmitted(
      { ...requested, surface: requested.surface ?? "" },
      deps.externalSlackPolicies,
      deps.sessions,
    ))
  )
    return {
      refused: { status: "refused", reason: "Slack workspace access changed; start a fresh request in Slack." },
    };
  if (!deps.identity.isInternal(requested.actor)) {
    return {
      refused: {
        status: "refused",
        refusalKind: "internal_only",
        reason: "internal-only: non-internal principals cannot interact",
      },
    };
  }
  const external = requested.externalSlack !== undefined;
  const externalServices = new Set(requested.externalSlack?.serviceCredentials ?? []);
  const serviceAllowed = (slug: string): boolean =>
    !external ||
    (externalServices.has(slug) &&
      (deps.externalSlackPolicies?.[requested.externalSlack!.accountId]?.serviceCredentials.includes(slug) ?? false));
  await deps.refreshModels?.();
  const input = await scopeTeamsToTurn(requested, deps, external);
  const { actor, conversation } = input;
  const automatedTurn = input.origin.kind === "automation";
  const ambientTurn = input.origin.kind === "ambient";
  const humanTurn = input.origin.kind === "human";
  const sessionTurn = isSessionTurn(input);
  const humanInput = humanTurn && !sessionTurn;
  const allInternal =
    deps.identity.audienceIsAllInternal(conversation.audience) &&
    (conversation.kind === "dm" ||
      (!!conversation.publishMembers?.length && conversation.publishMembers.every((p) => p.type === "internal")));
  const authoredDetection = input.origin.kind === "ambient" && input.origin.live === true && conversation.kind !== "dm";
  const actorFeatures =
    (await deps.featureFlags?.enabledFor(`personal:${actor.id}` as ScopeId)) ?? new Set<FeatureName>();
  const delegationEnabled = !external && actorFeatures.has("responsive_spine");
  const delegatedOrigin =
    !external && deps.runs
      ? await delegatedAuthorizationOrigin(input, { runs: deps.runs, sessions: deps.sessions })
      : undefined;
  const authorizationOrigin = sessionTurn ? (delegatedOrigin ?? { kind: "automation" as const }) : input.origin;
  const liveTurn = authorizationOrigin.kind === "human" && allInternal && !external;
  const liveAuthorTurn =
    !external && ((!sessionTurn && (humanTurn || authoredDetection)) || delegatedOrigin !== undefined) && allInternal;
  const messageTs = humanInput && input.origin.kind === "human" ? input.origin.messageTs : undefined;
  const entryTs =
    !sessionTurn && (input.origin.kind === "human" || input.origin.kind === "ambient")
      ? input.origin.entryTs
      : undefined;
  const coreReceivedAt = Date.now();
  const turnTimezone = isValidTimezone(input.timezone) ? input.timezone : undefined;

  const delegatedSession = isSubagentThreadRef(conversation.threadRef)
    ? await deps.sessions.getByThread(conversation.threadRef)
    : null;
  const subagentRefusal = await subagentSessionRefusal(deps, input, delegatedSession);
  if (subagentRefusal) return { refused: subagentRefusal };
  const managedGroupRef =
    conversation.kind === "group" && conversation.channelRef && deps.managedGroups?.recognizes(conversation.channelRef)
      ? conversation.channelRef
      : undefined;
  if (!(await managedRosterIsCurrent(deps, input, managedGroupRef))) return { refused: rosterChangedRefusal() };
  const limitRefusal = await turnLimitRefusal(deps, input, external);
  if (limitRefusal) return limitRefusal;

  return {
    admitted: {
      input,
      actor,
      conversation,
      external,
      serviceAllowed,
      automatedTurn,
      ambientTurn,
      sessionTurn,
      humanInput,
      allInternal,
      actorFeatures,
      delegationEnabled,
      authorizationOrigin,
      liveTurn,
      liveAuthorTurn,
      messageTs,
      entryTs,
      coreReceivedAt,
      turnTimezone,
      delegatedSession,
      withManagedRosterVersion: (fn) => withManagedRosterVersion(deps, input, managedGroupRef, fn),
    },
  };
}

async function subagentSessionRefusal(
  deps: OrchestratorDeps,
  { actor, conversation }: OrchestratorInput,
  delegatedSession: Session | null,
): Promise<TurnResult | undefined> {
  if (!isSubagentThreadRef(conversation.threadRef)) return undefined;
  const canWrite = createCanWriteScope({
    managedGroups: deps.managedGroups
      ? {
          recognizes: (ref) => deps.managedGroups!.recognizes(ref),
          members: (ref) => deps.managedGroups!.members(ref),
          membership: async (ref, id) => (await deps.managedGroups!.members(ref))?.includes(id),
        }
      : undefined,
    directory: deps.directory,
    identity: deps.identity,
  });
  if (
    !delegatedSession?.spawnMeta ||
    delegatedSession.scopeId !== deps.resolution.scopeFor(conversation, actor) ||
    !(await deps.sessions.getForParticipant(delegatedSession.id, actor.id)) ||
    !(await canWrite(actor.id, delegatedSession.scopeId))
  )
    return { status: "refused", reason: "subagent session access is no longer current" };
  return undefined;
}

async function managedRosterIsCurrent(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
  managedGroupRef: string | undefined,
): Promise<boolean> {
  if (!managedGroupRef) return true;
  const expected = new Set(input.sessionParticipantIds ?? []);
  const [current, version] = await Promise.all([
    deps.managedGroups!.members(managedGroupRef).catch(swallowAs("managed group roster: members", undefined)),
    deps.managedGroups!.version(managedGroupRef).catch(swallowAs("managed group roster: version", undefined)),
  ]);
  return (
    !!current &&
    version === input.scopeVersion &&
    rosterAdmits(current, input.actor.id, toScopeId("group", managedGroupRef)) &&
    current.length === expected.size &&
    current.every((id) => expected.has(id))
  );
}

async function withManagedRosterVersion<T>(
  deps: OrchestratorDeps,
  input: OrchestratorInput,
  managedGroupRef: string | undefined,
  fn: () => Promise<T>,
): Promise<T> {
  if (!managedGroupRef) return fn();
  const result = await deps.managedGroups!.withVersion(managedGroupRef, input.scopeVersion, fn);
  if (result === undefined) throw new ProjectRosterChanged();
  return result;
}

async function turnLimitRefusal(
  deps: OrchestratorDeps,
  { actor, conversation, surface }: OrchestratorInput,
  external: boolean,
): Promise<{ refused: TurnResult } | undefined> {
  if (conversation.kind !== "dm" && !deps.identity.audienceIsAllInternal(conversation.audience)) {
    const externalAllowed =
      external ||
      (surfaceHas(surface, "externalParticipants") &&
        (deps.config ? await deps.config.settingDurable("externalSlackParticipants", tenant().orgScope) : false));
    if (!externalAllowed) {
      return {
        refused: {
          status: "refused",
          refusalKind: "internal_only",
          reason: "internal-only: shared audience includes a non-internal participant",
        },
      };
    }
  }

  const rl = await deps.rateLimiter.check(actor.id);
  if (!rl.allowed) {
    return {
      refused: {
        status: "refused",
        reason: `rate limit exceeded — try again in ${Math.ceil((rl.retryAfterMs ?? 0) / 1000)}s`,
      },
    };
  }

  if (deps.budget) {
    const b = await deps.budget.check(actor.id);
    if (!b.allowed) {
      return {
        refused: {
          status: "refused",
          reason: `budget exceeded ($${b.spentUsd.toFixed(2)} of $${b.limitUsd}); try again later`,
        },
      };
    }
  }
  return undefined;
}
