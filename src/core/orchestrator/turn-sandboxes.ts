import type { TurnCtx } from "./turn-context.ts";
import type { frameTurnPrompt } from "./turn-prompt.ts";
import type { buildCredentialCatalog } from "./credential-catalog.ts";
import type { Session } from "../../types.ts";
import { currentExternalSlackRun } from "../../resolution/external-slack.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import type { GapPhase } from "../../sessions/session-store.ts";
import { renderComputerBlock, renderSandboxProfiles } from "../environment-facts.ts";
import { createTurnSandboxes } from "./sandboxes.ts";

export function openTurnSandboxes(
  ctx: TurnCtx,
  turn: {
    context: Awaited<ReturnType<typeof resolveTurnContext>>;
    framed: Awaited<ReturnType<typeof frameTurnPrompt>>;
    catalog: Awaited<ReturnType<typeof buildCredentialCatalog>>;
    session: Session;
    emitGapWork: (phase: GapPhase, start: number, end: number) => void;
  },
) {
  const { deps, input, actor, conversation, external, liveAuthorTurn, scopeId, resolution } = ctx;
  const { session, emitGapWork } = turn;
  const { memoryScopeId } = turn.context;
  const { turnContextBlocks, scopeProfile, visibleSkillsForTurn, transferId, turnSessionDir, turnFilesDir } =
    turn.framed;
  const { connectorEnv, egressTokenForPolicy, egressTokenForTurn, openAutomationKeychain } = turn.catalog;
  const turnSandboxResources = external
    ? deps.sandboxResources?.forTurn({
        actorId: actor.id,
        scopeId,
        isCurrent: async () =>
          !!(await currentExternalSlackRun(
            {
              actorId: actor.id,
              scopeId,
              runId: input.runId,
              runLeaseToken: input.runLeaseToken,
              runAttempt: input.attempt,
              threadRef: conversation.threadRef,
            },
            deps,
          )),
      })
    : deps.sandboxResources;
  const workspaceLayout = {
    hasGlobal: resolution.layers.some((l) => l.mountPath === "global"),
    teamCount: resolution.layers.filter((l) => l.mountPath.startsWith("team-")).length,
  };
  if (turnSandboxResources) {
    Object.assign(turnContextBlocks, renderSandboxProfiles(turnSandboxResources.profiles(), workspaceLayout));
  } else {
    turnContextBlocks["Sandbox environment profile"] = renderComputerBlock(scopeProfile.spec, workspaceLayout);
  }

  const sandboxes = createTurnSandboxes({
    ...ctx,
    deps: {
      ...deps,
      sandboxResources: turnSandboxResources,
      isCurrentSharedScopeMember: ctx.isCurrentSharedScopeMember,
    },
    session,
    memoryScopeId,
    transferId,
    turnSessionDir,
    turnFilesDir,
    connectorEnv,
    egressTokenForTurn,
    egressTokenForPolicy,
    openResourceAccess: !external && (liveAuthorTurn || openAutomationKeychain),
    visibleSkillsForTurn,
    emitGapWork,
  });
  return { turnSandboxResources, sandboxes };
}
