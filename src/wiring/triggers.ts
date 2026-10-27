import type { TurnRequest } from "../types.ts";
import type { KeychainAsk, KeychainGrant } from "../credentials/keychain.ts";
import {
  fireAskResolution,
  type DropResolution,
  fireDropResolution,
  createAskExpirySweep,
} from "../triggers/keychain-ask.ts";
import type { InboxServiceDeps } from "../api/routes/cron-items.ts";
import { createInboxChat } from "../inbox/item-chat.ts";
import type { ApiAppModule } from "./api-app.ts";
import type { OutboundModule } from "./outbound.ts";
import type { StoresModule } from "./stores.ts";
import type { CronsModule } from "./crons.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { DeploymentLayerModule } from "./deployment-layer.ts";

export function buildTriggers(
  w: ApiAppModule & OutboundModule & StoresModule & CronsModule & CredentialsModule & DeploymentLayerModule,
) {
  const {
    app,
    outbound,
    idempotency,
    identity,
    directory,
    currentScopeMembers,
    sessions,
    crons,
    keychain,
    advisoryLock,
    inboxItems,
    recordInboxEvent,
    auditLog,
  } = w;

  const resolveRecipient = (query: string) => app.resolveRecipient(query);
  const triggerDeps = {
    outbound,
    idempotency,
    identity,
    run: (req: TurnRequest) => app.turn(req),
    directory,
    resolveRecipient,
    currentScopeMembers,
    sessions,
  };
  const askResolution = (ask: KeychainAsk, grant?: KeychainGrant) =>
    fireAskResolution(
      {
        ...triggerDeps,
        getCron: (id) => crons.get(id),
        getAsk: (id) => keychain.getAsk(id),
        getGrant: (id) => keychain.getGrant(id),
      },
      ask,
      grant,
    );
  const dropResolution = (drop: DropResolution) => fireDropResolution(triggerDeps, drop);
  const inbox: InboxServiceDeps = {
    lock: advisoryLock,
    items: inboxItems,
    record: recordInboxEvent,
    chat: createInboxChat({
      items: inboxItems,
      trigger: triggerDeps,
    }),
  };
  const sweepAsks = createAskExpirySweep({ keychain, fire: askResolution, auditLog });
  return { askResolution, triggerDeps, sweepAsks, inbox, dropResolution };
}

export type TriggersModule = ReturnType<typeof buildTriggers>;
