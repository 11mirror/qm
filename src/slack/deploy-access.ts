import { z } from "zod";
import type { App } from "../api/app-types.ts";
import type { SlackCoreClient } from "../api/slack-core-client.ts";
import type { IdentityService } from "../identity/identity-service.ts";
import { principalDestination } from "../reach/reach.ts";
import { parseScopeId, scopeId, type ActorAssertion, type Destination } from "../types.ts";
import type { Directory } from "./directory.ts";
import { registerDecisionButtons, type ActionApp } from "./messaging.ts";

const ACTIONS = ["deploy_access_approve", "deploy_access_decline"] as const;
type Request = NonNullable<Destination["deploymentAccess"]>;

const DEPLOY_ACCESS_REQUEST = z.strictObject({
  deploymentId: z.guid(),
  requesterId: z.string().regex(/^[^\s\p{Cc}<>|:]{1,320}$/u),
});

export function parseDeployAccess(value: string): Request {
  if (value.length > 2000) throw new Error("Invalid access request.");
  const parsed = DEPLOY_ACCESS_REQUEST.safeParse(JSON.parse(value));
  if (!parsed.success) throw new Error("Invalid access request.");
  return parsed.data;
}

export function deployAccessMessage(
  request: Request,
  text: string,
): { text: string; blocks: Array<Record<string, unknown>> } {
  const value = JSON.stringify(request);
  parseDeployAccess(value);
  return {
    text,
    blocks: [
      { type: "section", text: { type: "plain_text", text: text.slice(0, 3000) } },
      {
        type: "actions",
        elements: ACTIONS.map((action_id, i) => ({
          type: "button",
          action_id,
          value,
          text: { type: "plain_text", text: i === 0 ? "Approve" : "Decline" },
          style: i === 0 ? "primary" : "danger",
        })),
      },
    ],
  };
}

export async function decideDeploymentAccess(
  app: App,
  identity: IdentityService,
  value: string,
  assertion: ActorAssertion,
  approve: boolean,
): Promise<string> {
  const { deploymentId, requesterId } = parseDeployAccess(value);
  await identity.refresh(true);
  const actor = identity.resolve(assertion);
  if (!identity.isInternal(actor)) throw new Error("Only the app's owner can decide this request.");
  const home = await app.getArtifactHome("deploy", deploymentId);
  if (
    !home ||
    !(await (parseScopeId(home.ownerScopeId).kind === "personal"
      ? app.belongsToScope(actor.id, home.ownerScopeId)
      : app.canManageArtifactHome(home.ownerScopeId, home.createdBy, actor.id)))
  )
    throw new Error("Only the app's owner can decide this request.");
  const d = await app.getDeployment(deploymentId);
  if (!d) throw new Error("That app no longer exists.");
  const label = d.displayName ?? d.name ?? d.id;
  if (approve) {
    const grantee = scopeId("personal", requesterId);
    const existing = (await app.deploymentGrantees(deploymentId)).find(
      (g) => g.scope === grantee && g.permission === "write",
    );
    await app.grant({
      ownerScopeId: home.ownerScopeId,
      ref: home.grantRef,
      granteeScopeId: grantee,
      permission: existing?.permission ?? "read",
      grantedBy: actor.id,
    });
    return `Approved. ${requesterId} can now open "${label}".`;
  }
  await app.postToSurface({
    destination: principalDestination(requesterId, actor.id),
    text: `${actor.id} declined your request for access to "${label}".`,
    idempotencyKey: `deploy-declined:${deploymentId}:${requesterId.toLowerCase()}:${Math.floor(Date.now() / 86_400_000)}`,
  });
  return `Declined. ${requesterId} was told.`;
}

export function registerDeployAccessActions(
  app: ActionApp,
  deps: { core: SlackCoreClient; directory: Directory },
): void {
  registerDecisionButtons(
    app,
    /^deploy_access_/,
    ACTIONS,
    { directory: deps.directory, failure: "Couldn't complete that", label: "slack: app access decision failure" },
    async (actionId, value, actor) => {
      const text = await deps.core.decideDeploymentAccess(value, actor, actionId === ACTIONS[0]);
      return { text, blocks: [{ type: "section", text: { type: "plain_text", text } }] };
    },
  );
}
