import type { Head } from "./late.ts";
import { createMonitorStore } from "../monitors/monitor-store.ts";
import type { PendingApprovalRecord } from "../types.ts";
import type { LedgerEvent } from "../inbox/events.ts";
import { swallowAs } from "../util/errors.ts";
import { createInboxLedger, type InboxEventSink } from "../inbox/ledger.ts";
import { createPostgresCronFireStore } from "../cron/fire-store.ts";
import { createCronStore, type CronStore } from "../cron/cron-store.ts";
import { RUN_MAX_AGE_MS } from "../runs/reaper.ts";
import { createWebhookStore } from "../webhooks/webhook-store.ts";
import { createApprovalStore } from "../core/approval-store.ts";
import { createSecurityScreenProxy } from "../security/security-screener.ts";
import type { StoresModule } from "./stores.ts";
import type { RunsModule } from "./runs.ts";
import type { OutboundModule } from "./outbound.ts";

export function buildCrons(w: Head & StoresModule & RunsModule & OutboundModule) {
  const { artifactMap, ledgerEventBus, late, databaseUrl, config, outbound, chatSurfaces, overrides } = w;

  const monitors = createMonitorStore(databaseUrl);
  const cronOwnerCache = new Map<string, string>();
  const publishInboxEvent = (event: LedgerEvent): void => {
    void (async () => {
      let owner = cronOwnerCache.get(event.cronId);
      if (owner === undefined) {
        owner = (await crons.get(event.cronId))?.owner ?? "";
        cronOwnerCache.set(event.cronId, owner);
      }
      if (owner) ledgerEventBus.emit({ ...event, owner });
    })().catch(swallowAs("inbox: publish ledger event", undefined));
  };
  const inboxItems = createInboxLedger(databaseUrl, publishInboxEvent);
  const recordInboxEvent: InboxEventSink = async (item, event) => {
    if (await inboxItems.recordEvent(item, event)) await late.scheduler.runNow(item.cronId);
  };
  const cronFires = createPostgresCronFireStore(databaseUrl);
  const cronsBase = createCronStore(databaseUrl, {
    staleRunningMs: RUN_MAX_AGE_MS,
    fires: cronFires,
  });
  const crons: CronStore = {
    ...cronsBase,
    async create(input) {
      const cron = await cronsBase.create(input);
      late.scheduler.notifyChanged(cron.id);
      return cron;
    },
    async update(id, patch) {
      const cron = await cronsBase.update(id, patch);
      late.scheduler.notifyChanged(id);
      return cron;
    },
    async setEnabled(id, enabled) {
      await cronsBase.setEnabled(id, enabled);
      late.scheduler.notifyChanged(id);
    },
    async delete(id) {
      await cronsBase.delete(id);
      await inboxItems.deleteByCron(id);
    },
  };
  const webhooks = createWebhookStore(databaseUrl);
  const webUiBase = (config.slack?.webUiPublicUrl ?? config.publicWebUrl)?.replace(/\/+$/, "");
  const approvals = createApprovalStore(artifactMap<PendingApprovalRecord>("approvals", ["sessionId"]), outbound, {
    surfaces: chatSurfaces,
    webSessionUrl: (sessionId) => (webUiBase ? `${webUiBase}/s/${encodeURIComponent(sessionId)}` : undefined),
  });
  late.approvals = approvals;
  let securityScreener = overrides.securityScreener;
  if (!securityScreener && config.securityScreenProxy) {
    securityScreener = createSecurityScreenProxy({
      ...config.securityScreenProxy,
      timeoutMs: config.securityScreenTimeoutMs,
    });
  }
  return { securityScreener, approvals, monitors, crons, webhooks, inboxItems, recordInboxEvent };
}

export type CronsModule = ReturnType<typeof buildCrons>;
