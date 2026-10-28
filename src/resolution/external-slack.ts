import type { CapabilityClaims } from "../auth/capability-token.ts";
import type { RunStore } from "../runs/run-store.ts";
import { activeCapabilityRun } from "../runs/capability-run.ts";
import { conversationScope } from "./resolution-service.ts";
import { externalSlackNamespace, type ExternalSlackAccess } from "../slack/external-access.ts";
import { type TurnRequest, turnSource } from "../types.ts";
import type { SessionStore } from "../sessions/session-store.ts";
import { surfaceHas } from "../surfaces/surface.ts";

export type ExternalSlackPolicies = Readonly<Record<string, ExternalSlackAccess>>;

export function externalSlackRequestAllowed(
  request: Pick<TurnRequest, "externalSlack" | "source" | "slackSource" | "surface"> & {
    conversation: Pick<TurnRequest["conversation"], "kind" | "channelRef" | "threadRef">;
  },
  policies: ExternalSlackPolicies = {},
  historicalSlack = false,
): boolean {
  const ref = request.conversation.channelRef ?? request.conversation.threadRef;
  if (request.externalSlack) {
    const supplied = request.externalSlack;
    const current = policies[supplied.accountId];
    return (
      !!current &&
      request.conversation.kind !== "dm" &&
      externalSlackNamespace(supplied.teamId, current) ===
        externalSlackNamespace(supplied.teamId, {
          companyDomains: supplied.companyDomains,
          companyTeamIds: supplied.companyTeamIds,
          serviceCredentials: supplied.serviceCredentials,
        }) &&
      ref.startsWith(`${externalSlackNamespace(supplied.teamId, current)}:`)
    );
  }
  if (ref.includes("external-slack:")) return false;
  const native = surfaceHas(request.surface, "externalParticipants");
  const source = native || historicalSlack ? turnSource(request) : undefined;
  if (source) {
    const policy = policies[source.account];
    return (
      !policy ||
      (request.conversation.kind === "dm" &&
        source.policyNamespace === externalSlackNamespace(source.workspaceId, policy))
    );
  }
  if (ref.startsWith("slack-account:")) return false;
  if (request.conversation.kind === "dm") return true;
  return !(Object.keys(policies).length && (native || historicalSlack));
}

export async function externalSlackAdmitted(
  request: Parameters<typeof externalSlackRequestAllowed>[0],
  policies: ExternalSlackPolicies | undefined,
  sessions: Pick<SessionStore, "getByThread">,
): Promise<boolean> {
  const historicalSlack =
    Object.keys(policies ?? {}).length > 0 &&
    surfaceHas((await sessions.getByThread(request.conversation.threadRef))?.surface, "externalParticipants");
  return externalSlackRequestAllowed(request, policies, historicalSlack);
}

export async function currentExternalSlackRun(
  claims: Pick<CapabilityClaims, "runId" | "runLeaseToken" | "runAttempt" | "threadRef" | "actorId" | "scopeId">,
  deps: { runs?: RunStore; externalSlackPolicies?: ExternalSlackPolicies },
) {
  const run = await activeCapabilityRun(deps.runs, claims);
  if (
    !run ||
    !run.request.externalSlack ||
    !externalSlackRequestAllowed({ ...run.request, surface: run.request.surface ?? "" }, deps.externalSlackPolicies) ||
    conversationScope(run.request.conversation, run.request.actor.id) !== claims.scopeId
  )
    return null;
  return run;
}
