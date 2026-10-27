import type { Head } from "./late.ts";
import { adminSessionUrl } from "../util/admin-links.ts";
import { wireRunResultPosts } from "../runs/run-results.ts";
import { createGitFetcher, resolvePackAuth } from "../skills/pack-fetcher.ts";
import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import { scopeId } from "../types.ts";
import { swallowAs } from "../util/errors.ts";
import {
  type AmbientJudgmentStore,
  createPostgresAmbientJudgmentStore,
} from "../surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore, createPostgresAckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { SecurityScreenProbe } from "../security/security-screener.ts";
import { estimateCostUsd } from "../ratelimit/budget.ts";
import type { RunsModule } from "./runs.ts";
import type { OutboundModule } from "./outbound.ts";
import type { StoresModule } from "./stores.ts";
import type { CredentialsModule } from "./credentials.ts";
import type { FilesModule } from "./files.ts";
import type { ModelCredentialsModule } from "./model-credentials.ts";
import type { HarnessModule } from "./harness.ts";

export function buildAppServices(
  w: Head &
    RunsModule &
    OutboundModule &
    StoresModule &
    CredentialsModule &
    FilesModule &
    ModelCredentialsModule &
    HarnessModule,
) {
  const {
    config,
    runs,
    outbound,
    sessions,
    chatSurfaces,
    serviceCreds,
    keychain,
    databaseUrl,
    directProviderAvailability,
    harness,
    modelGateway,
    budget,
  } = w;

  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const recoveryAdminBase = config.publicWebUrl;
  const recoveryAdminUrlFor = recoveryAdminBase
    ? (sessionId: string): string | undefined =>
        uuidId.test(sessionId) ? adminSessionUrl(recoveryAdminBase, sessionId) : undefined
    : undefined;
  const runResultRecovery = wireRunResultPosts(runs, outbound, {
    ...(recoveryAdminUrlFor ? { adminUrlFor: recoveryAdminUrlFor } : {}),
    sessions,
    postsImmediately: chatSurfaces.receives,
  });
  const skillFetcher = createGitFetcher({
    allowLocalRepos: !config.production,
    resolveAuth: (pack) =>
      resolvePackAuth(
        {
          serviceCredential: async (slug) => {
            const record = nonDeploymentCredential(
              await serviceCreds.getServiceCredentialSecret(scopeId("org", config.orgId), slug),
            );
            return record && record.delivery !== "env" ? record : undefined;
          },
          connectorToken: async (host, principalId) =>
            (await keychain.connectorAccessToken(host, principalId)) ?? undefined,
        },
        pack,
      ),
  });
  const ambientJudgments: AmbientJudgmentStore = createPostgresAmbientJudgmentStore(databaseUrl);
  const ackEmojiPicks: AckEmojiPickStore = createPostgresAckEmojiPickStore(databaseUrl);
  const providerKeys = directProviderAvailability;
  const screenSecurity: SecurityScreenProbe | undefined = harness.models.screenSecurity
    ? ({ payload, modelId, systemPrompt, actorId, scopeLabel, signal }) =>
        harness.models.screenSecurity!({
          payload,
          modelId,
          systemPrompt,
          signal,
          recordModelCall: (rec) => {
            modelGateway.recordCall({ at: Date.now(), scopeLabel, ...rec });
            void budget
              ?.record(actorId, estimateCostUsd(rec.inputTokens))
              .catch(swallowAs("budget: record screen spend", undefined));
          },
        })
    : undefined;
  return {
    skillFetcher,
    screenSecurity,
    ambientJudgments,
    ackEmojiPicks,
    providerKeys,
    runResultRecovery,
  };
}

export type AppServicesModule = ReturnType<typeof buildAppServices>;
