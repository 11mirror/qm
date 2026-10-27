import { adminSessionUrl } from "../util/admin-links.ts";
import { wireRunResultPosts } from "../runs/run-results.ts";
import { createGitFetcher, resolvePackAuth } from "../skills/pack-fetcher.ts";
import { nonDeploymentCredential } from "../credentials/deployment-credentials.ts";
import { scopeId } from "../types.ts";
import { type Reaper, createReaper, RUN_MAX_AGE_MS, REAPER_LEASE_KEY } from "../runs/reaper.ts";
import { createEngagedRegistry } from "../wake/engaged-registry.ts";
import { swallowAs } from "../util/errors.ts";
import {
  type AmbientJudgmentStore,
  createPostgresAmbientJudgmentStore,
} from "../surface-cache/ambient-judgment-store.ts";
import { type AckEmojiPickStore, createPostgresAckEmojiPickStore } from "../surface-cache/ack-emoji-pick-store.ts";
import type { SecurityScreenProbe } from "../security/security-screener.ts";
import { estimateCostUsd } from "../ratelimit/budget.ts";
import type { Config } from "../config.ts";
import type { Runs } from "./runs.ts";
import type { OutboundModule } from "./outbound.ts";
import type { Stores } from "./stores.ts";
import type { Credentials } from "./credentials.ts";
import type { Files } from "./files.ts";
import type { ModelCredentials } from "./model-credentials.ts";
import type { HarnessModule } from "./harness.ts";

export function buildAppServices(
  w: Pick<Runs, "runs"> &
    Pick<OutboundModule, "outbound" | "chatSurfaces"> &
    Pick<Stores, "sessions" | "leaderLease"> &
    Pick<Credentials, "serviceCreds" | "keychain" | "modelGateway"> &
    Pick<Files, "errors" | "budget"> &
    Pick<ModelCredentials, "directProviderAvailability"> &
    Pick<HarnessModule, "harness"> & { config: Config; databaseUrl: string },
) {
  const {
    config,
    runs,
    outbound,
    sessions,
    chatSurfaces,
    serviceCreds,
    keychain,
    leaderLease,
    errors,
    databaseUrl,
    directProviderAvailability,
    harness,
    modelGateway,
    budget,
  } = w;

  const uuidId = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  const recoveryAdminBase = config.publicWebUrl?.replace(/\/$/, "");
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
  const reaper: Reaper = createReaper(runs, sessions, {
    intervalMs: config.reaperIntervalMs,
    leaderLease,
    maxAgeMs: RUN_MAX_AGE_MS,
    errors,
  });
  const engaged = createEngagedRegistry();
  let reapInFlight = false;
  let lastReapAt = 0;
  const REAP_POKE_COOLDOWN_MS = 1_000;
  const pokeReaper = (): void => {
    if (reapInFlight || Date.now() - lastReapAt < REAP_POKE_COOLDOWN_MS) return;
    reapInFlight = true;
    void leaderLease
      .hold(REAPER_LEASE_KEY, () => reaper.sweep())
      .catch(swallowAs("wake: reaper poke", null))
      .finally(() => {
        reapInFlight = false;
        lastReapAt = Date.now();
      });
  };
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
    engaged,
    pokeReaper,
    screenSecurity,
    ambientJudgments,
    ackEmojiPicks,
    providerKeys,
    runResultRecovery,
    reaper,
  };
}

export type AppServicesModule = ReturnType<typeof buildAppServices>;
