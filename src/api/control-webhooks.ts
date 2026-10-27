import type { Webhook } from "../types.ts";
import { resolveCapabilityDestination } from "./capability-destination.ts";
import { errMessage } from "../util/errors.ts";
import { livePersonCapability } from "./artifact-share.ts";
import { fail, type ControlOp } from "./control-result.ts";
import type { ControlService, WebhookCreateResult } from "./control-service.ts";
import type { App } from "./app.ts";

const unknownDestination = () =>
  fail("unknown_destination", "destinationKey is not one of the destinations available for this conversation");

export async function editWebhookTask(
  app: App,
  id: string,
  action: string,
  principalId: string,
): ControlOp<{ webhook: Webhook }, "bad_request"> {
  if (!action.trim()) return fail("bad_request", "task cannot be empty");
  const webhook = await app.getWebhook(id);
  if (!webhook) return fail("not_found", `no webhook ${id}`);
  if (!(await canAdministerWebhook(app, webhook, principalId))) return fail("forbidden", "not your webhook");
  const updated = await app.updateWebhook(id, { action });
  return updated ? { ok: true, webhook: updated } : fail("not_found", `no webhook ${id}`);
}

export async function canAdministerWebhook(
  app: Pick<App, "membershipControlsScope" | "managesScope" | "samePerson">,
  webhook: Pick<Webhook, "ownerScopeId" | "owner">,
  actorId: string,
  isActor?: (id: string) => Promise<boolean>,
): Promise<boolean> {
  if (await app.membershipControlsScope(webhook.ownerScopeId)) {
    return app.managesScope(actorId, webhook.ownerScopeId);
  }
  return isActor ? isActor(webhook.owner) : app.samePerson(webhook.owner, actorId);
}

export function webhookMethods(
  app: App,
): Pick<ControlService, "createWebhook" | "listWebhooks" | "disableWebhook" | "updateWebhook"> {
  return {
    async createWebhook(req, capability, publicBase): Promise<WebhookCreateResult> {
      if (capability.triggered || !livePersonCapability(capability))
        return fail("forbidden", "webhook registration requires a live turn started by its owner");
      const resolved = resolveCapabilityDestination(capability, req.destinationKey);
      if (!resolved.ok) return unknownDestination();
      try {
        const webhook = await app.createWebhook({
          action: req.action,
          verification: req.verification,
          owner: capability.actorId,
          createdBy: capability.actorId,
          ownerScopeId: capability.scopeId,
          ...(req.filters?.length ? { filters: req.filters } : {}),
          ...(resolved.destination ? { destination: resolved.destination } : {}),
        });
        const incomingPath = `/v1/webhooks/incoming/${webhook.id}`;
        const base = publicBase ?? "";
        return {
          ok: true,
          webhook,
          url: base ? `${base}${incomingPath}` : incomingPath,
          ...(webhook.verification.secret ? { secret: webhook.verification.secret } : {}),
        };
      } catch (e) {
        return fail("webhook_create_failed", errMessage(e));
      }
    },

    async listWebhooks(capability) {
      const all = await app.listWebhooks();
      const isActor = await app.personMatcher(capability.actorId);
      const allowed = await Promise.all(
        all.map((webhook) => canAdministerWebhook(app, webhook, capability.actorId, isActor)),
      );
      return all.filter((_webhook, index) => allowed[index]);
    },

    async disableWebhook(id, capability) {
      const webhook = await app.getWebhook(id);
      if (!webhook) return fail("not_found", `no webhook ${id}`);
      if (!(await canAdministerWebhook(app, webhook, capability.actorId))) return fail("forbidden", "not your webhook");
      await app.setWebhookEnabled(id, false);
      return { ok: true };
    },

    async updateWebhook(id, patch, capability) {
      if (capability.triggered || !livePersonCapability(capability))
        return fail("forbidden", "editing a webhook requires a live turn started by its owner");
      return editWebhookTask(app, id, patch.action, capability.actorId);
    },
  };
}
