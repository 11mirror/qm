import type { Session } from "../../types.ts";
import { isBackendCredential } from "../../credentials/keychain.ts";
import { resolveBrowserModel } from "../../model/browser-model.ts";
import { type Destination } from "../../types.ts";
import { personalScope } from "../../types.ts";
import { resolveTurnContext } from "../../resolution/turn-context.ts";
import { connectorTokenNote } from "../../credentials/connector-token.ts";
import {
  credentialHandle,
  type PublicServiceCredential,
  type KeychainManifestInput,
} from "../../credentials/keychain.ts";
import { PROVIDERS } from "../../connectors/oauth.ts";
import {
  mintCapabilityToken,
  CAPABILITY_TTL_MS,
  SANDBOX_CAPABILITY_TTL_MS,
  CONTROL_PLANE_AUD,
  BROWSER_MODEL_AUD,
  SANDBOX_MODEL_AUD,
  OAUTH_CONSENT_AUD,
  CREDENTIAL_BROKER_AUD,
  EGRESS_PROXY_AUD,
  type BrokeredConnector,
  type CapabilityClaims,
} from "../../auth/capability-token.ts";
import { type CommandCredential } from "../../tools/primitives.ts";
import { principalEntitledToScope } from "../../resolution/context-filter.ts";
import { parseRef } from "../../acl/resource-ref.ts";
import { swallowAs } from "../../util/errors.ts";
import { deliveryCandidatesFor, egressClaimAllowingControlPlane } from "./turn-helpers.ts";
import type { EgressPolicy } from "../../types.ts";
import { isOpenScopeMember } from "../../resolution/sharing-access.ts";
import { tenant } from "../../tenant.ts";

import type { TurnCtx } from "./turn-context.ts";
import { SANDBOX_MODEL_PREFIX } from "../../api/contract.ts";

const CONNECTOR_HOSTS = Object.values(PROVIDERS).flatMap((p) => p.hosts);

export async function buildCredentialCatalog(
  ctx: TurnCtx,
  turn: {
    strictReadOnly: boolean;
    sharingSources: Awaited<ReturnType<typeof resolveTurnContext>>["sharingSources"];
    delivery: ReturnType<typeof deliveryCandidatesFor>;
    defaultDestination: Destination | undefined;
    session: Session;
  },
) {
  const {
    deps,
    input,
    actor,
    conversation,
    external,
    serviceAllowed,
    automatedTurn,
    allInternal,
    liveTurn,
    liveAuthorTurn,
    turnTimezone,
    resolution,
    scopeId,
    isCurrentSharedScopeMember,
  } = ctx;
  const { strictReadOnly, sharingSources, delivery, defaultDestination, session } = turn;
  const brokeredTools = external ? [] : (deps.brokeredTools ?? []);
  const openSpeakerKeychain =
    liveAuthorTurn && conversation.kind !== "dm" && sharingSources.includes(personalScope(actor.id));
  const openAutomationKeychain =
    !external &&
    input.origin.kind === "automation" &&
    input.origin.useOwnerKeychain === true &&
    conversation.kind !== "dm" &&
    !!deps.isCurrentSharedScopeMember &&
    (await isOpenScopeMember({
      actorId: actor.id,
      scope: scopeId,
      isCurrentSharedScopeMember: deps.isCurrentSharedScopeMember,
    }));
  const isolateOwnerKeychain = !external && (openSpeakerKeychain || openAutomationKeychain);
  const ownerAuthAvailable = isolateOwnerKeychain;
  const connectorEnv: Record<string, string> = {};
  const commandCredentials: CommandCredential[] = [];
  const credentialDescriptions: NonNullable<KeychainManifestInput["execution"]> = [];
  const credentialIdentities = new Map<string, string>();

  const authorizeOwnerCredentials = async (): Promise<void> => {
    if ((openSpeakerKeychain || openAutomationKeychain) && !(await isCurrentSharedScopeMember(actor.id, scopeId))) {
      throw new Error("Open speaker keychain access is no longer authorized");
    }
  };
  // Brokered credentials (shared org credentials and connected-app OAuth tokens) never enter the
  // sandbox: each selected one resolves to the same AGENT_CREDENTIAL_TOKEN, minted once per command
  // over every brokered handle that command requested; the broker injects auth server-side.
  type CredentialBroker = ReturnType<typeof credentialBroker>;
  const credentialBroker = (requested: readonly string[]) => {
    const credentials: string[] = [];
    const connectors: BrokeredConnector[] = [];
    let token: Promise<string> | undefined;
    return {
      service: (slug: string) => {
        if (requested.includes(slug) && !credentials.includes(slug)) credentials.push(slug);
      },
      connector: (connector: BrokeredConnector) => {
        if (requested.includes(connector.handle) && !connectors.some((c) => c.handle === connector.handle))
          connectors.push(connector);
      },
      env: async () => [
        { key: "AGENT_API_URL", value: deps.apiBaseUrl!, secret: false },
        {
          key: "AGENT_CREDENTIAL_TOKEN",
          value: await (token ??= mintBrokerToken(credentials.toSorted(), connectors)),
        },
      ],
    };
  };
  const brokerAvailable = Boolean(deps.signingSecret && deps.apiBaseUrl);
  const connectorOf = (
    credential: import("../../credentials/keychain.ts").KeychainCredentialMeta,
    grantId?: string,
  ): BrokeredConnector | undefined =>
    credential.managed === "connector" && credential.host
      ? {
          handle: credentialHandle(credential),
          host: credential.host,
          ownerId: credential.ownerId,
          ...(credential.refresh?.accountType ? { accountType: credential.refresh.accountType } : {}),
          ...(grantId ? { grantId } : {}),
        }
      : undefined;
  const resolvedCredential = async (
    materialized: import("../../credentials/keychain.ts").MaterializedCred,
    broker: CredentialBroker,
  ) => {
    if (materialized.kind === "connector") return { env: await broker.env() };
    if (materialized.kind === "env") return { env: materialized.env };
    return {
      env: [],
      files: {
        files: materialized.files,
        save: (files: import("../../credentials/keychain.ts").CredentialFile[]) =>
          deps.keychain!.updateFiles(materialized, files),
        source: {
          credentialId: materialized.credentialId,
          ownerId: materialized.ownerId,
          service: materialized.service,
          ...(materialized.grantId ? { grantId: materialized.grantId } : {}),
        },
      },
    };
  };
  const addCredentialToCatalog = (
    credential: CommandCredential,
    description: string,
    identity = credential.handle,
    ownerId = actor.id,
    credentialId?: string,
  ): void => {
    const existing = credentialIdentities.get(credential.handle);
    if (existing !== undefined) {
      if (existing !== identity) throw new Error(`credential handle collision: ${credential.handle}`);
      return;
    }
    credentialIdentities.set(credential.handle, identity);
    commandCredentials.push(credential);
    credentialDescriptions.push({
      handle: credential.handle,
      ownerId,
      description,
      credentialId,
      scope: credential.scope ?? "scoped",
    });
  };
  const registerKeychainCredentials = async (
    addCredential: typeof addCredentialToCatalog,
    broker: CredentialBroker,
  ): Promise<void> => {
    if (external || strictReadOnly || !deps.keychain) return;
    const keychain = deps.keychain;
    for (const { grant, credential } of await keychain.grantsForScope(scopeId)) {
      if (credential.kind === "broker" || isBackendCredential(credential)) continue;
      const connector = connectorOf(credential, grant.id);
      if (connector && !brokerAvailable) continue;
      if (connector) broker.connector(connector);
      addCredential(
        {
          handle: credentialHandle(credential),
          resolve: async () => {
            const prepared = await keychain.prepareMaterialize(grant.id, scopeId, actor.id);
            return {
              ...(await resolvedCredential(prepared.materialized, broker)),
              commit: prepared.commit,
              singleUse: prepared.singleUse,
            };
          },
        },
        `${credential.service}, owner ${credential.ownerId}, grant ${grant.id}${connector ? `; ${connectorTokenNote(connector.host)}` : ""}`,
        credential.id,
        credential.ownerId,
        credential.id,
      );
    }
    const ownAllowed = scopeId === personalScope(actor.id) || isolateOwnerKeychain;
    if (ownAllowed) {
      for (const credential of await keychain.listByOwner(actor.id)) {
        if (credential.kind === "broker" || isBackendCredential(credential)) continue;
        const connector = connectorOf(credential);
        if (connector && !brokerAvailable) continue;
        if (connector) broker.connector(connector);
        addCredential(
          {
            handle: credentialHandle(credential),
            scope: isolateOwnerKeychain ? "owner" : "scoped",
            resolve: async () => {
              await authorizeOwnerCredentials();
              return resolvedCredential(
                await keychain.materializeOwnById(actor.id, credential.id, personalScope(actor.id)),
                broker,
              );
            },
          },
          `${credential.service}, owner ${credential.ownerId}${connector ? `; ${connectorTokenNote(connector.host)}` : ""}`,
          credential.id,
          credential.ownerId,
          credential.id,
        );
      }
    }
  };
  const catalogBroker = credentialBroker([]);
  await registerKeychainCredentials(addCredentialToCatalog, catalogBroker);
  const registerConnectorCredentials = async (
    addCredential: typeof addCredentialToCatalog,
    broker: CredentialBroker,
  ): Promise<void> => {
    if (
      !external &&
      !strictReadOnly &&
      brokerAvailable &&
      deps.connectorTokens &&
      (scopeId === personalScope(actor.id) || openSpeakerKeychain || openAutomationKeychain)
    ) {
      const tokens = deps.connectorTokens;
      const inventory = tokens.listConnectorsByOwners
        ? ((await tokens.listConnectorsByOwners([actor.id])).get(actor.id) ?? [])
        : undefined;
      for (const host of CONNECTOR_HOSTS) {
        for (const accountType of ["personal", undefined, "company"]) {
          const status = inventory
            ? inventory.find(
                (credential) =>
                  credential.host === host && (credential.accountType ?? "default") === (accountType ?? "default"),
              )
            : await tokens.connectorTokenStatus(host, actor.id, accountType);
          if (!status?.connected || status.needsReconnect) continue;
          const handle = `connector:${host}:${accountType ?? "default"}`;
          broker.connector({ handle, host, ownerId: actor.id, ...(accountType ? { accountType } : {}) });
          addCredential(
            {
              handle,
              scope: isolateOwnerKeychain ? "owner" : "scoped",
              resolve: async () => {
                await authorizeOwnerCredentials();
                if (!(await tokens.connectorAccessToken(host, actor.id, accountType)))
                  throw new Error(`Connector is no longer available: ${host}`);
                return { env: await broker.env() };
              },
            },
            `${host} connector, account ${accountType ?? "default"}; ${connectorTokenNote(host)}`,
            "credentialId" in status ? status.credentialId : undefined,
            actor.id,
            "credentialId" in status ? status.credentialId : undefined,
          );
        }
      }
    }
  };
  await registerConnectorCredentials(addCredentialToCatalog, catalogBroker);
  // Service credentials: one read of the org's credential list and one grant scan feed both
  // the env-delivery gate (below) and the broker token mint (further down). Same grants gate both.
  const aclGrantedServiceCredSlugs = async (): Promise<Set<string>> =>
    new Set(
      (
        await deps.acl.grantsOfKind(
          "service-cred",
          conversation.audience,
          scopeId,
          resolution.orgScopeId,
          principalEntitledToScope,
        )
      ).map((g) => parseRef(g.ref).id),
    );
  const orgWideAudience =
    conversation.audience.length > 0 &&
    conversation.audience.every((p) =>
      principalEntitledToScope(p, resolution.orgScopeId, scopeId, resolution.orgScopeId),
    );
  const grantedServiceCredSlugs = async (records: readonly PublicServiceCredential[]): Promise<Set<string>> => {
    const granted = await aclGrantedServiceCredSlugs();
    if (orgWideAudience) for (const record of records) if (record.source === "deployment") granted.add(record.slug);
    return granted;
  };
  let serviceCredRecords: PublicServiceCredential[] = [];
  let grantedCredSlugs = new Set<string>();
  if (!strictReadOnly && deps.serviceCreds) {
    serviceCredRecords = (await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId)).filter((record) =>
      serviceAllowed(record.slug),
    );
    if (serviceCredRecords.length > 0) grantedCredSlugs = await grantedServiceCredSlugs(serviceCredRecords);
  }
  const authorizeServiceCredential = async (slug: string): Promise<void> => {
    if (!serviceAllowed(slug)) throw new Error("Service is not approved for external Slack.");
    if ((await aclGrantedServiceCredSlugs()).has(slug)) return;
    const supplied =
      orgWideAudience &&
      ((await deps.serviceCreds?.listServiceCredentials(resolution.orgScopeId)) ?? []).some(
        (record) => record.slug === slug && record.source === "deployment",
      );
    if (!supplied) {
      throw new Error(`Service credential is no longer authorized: ${slug}`);
    }
  };
  if (!strictReadOnly && allInternal && deps.serviceCreds) {
    // Env delivery is gated by the same service-cred grants as the broker: the env var rides
    // only when every internal participant in this conversation is entitled to the credential.

    const browseSteps = deps.config?.setting("browseMaxSteps", tenant().orgScope);
    if (browseSteps && !("BROWSE_LAB_MAX_STEPS" in connectorEnv))
      connectorEnv.BROWSE_LAB_MAX_STEPS = String(browseSteps);
  }
  const browserSelection =
    !strictReadOnly && allInternal
      ? await resolveBrowserModel({
          actorId: actor.id,
          config: deps.config,
          credentials: deps.userModelCredentials,
          companyModel: deps.resolveBaseModelId?.(),
        })
      : undefined;
  const managedBrowse = browserSelection;
  if (managedBrowse) {
    connectorEnv.BROWSE_LAB_MODEL_PROVIDER = "managed";
    connectorEnv.BROWSE_LAB_MODEL = browserSelection.model ?? "unavailable";
  }
  let actorIsOrgAdmin = false;
  let sandboxModelGateway = false;
  let controlClaims: CapabilityClaims | undefined;
  const sandboxTokenExpiry = Date.now() + SANDBOX_CAPABILITY_TTL_MS;
  const scopeAttestation = {
    ...(external ? { externalSlack: true as const } : {}),
    actorId: actor.id,
    scopeId,
    ...(input.scopeVersion ? { scopeVersion: input.scopeVersion } : {}),
    ...(conversation.publishMembers ? { members: conversation.publishMembers } : {}),
    ...(liveTurn ? { liveActor: true } : {}),
    ...(input.botActor ? { botActor: true } : {}),
  };
  if (!strictReadOnly && deps.signingSecret && deps.apiBaseUrl) {
    const destination = defaultDestination;
    connectorEnv.AGENT_API_URL = deps.apiBaseUrl;
    if (deps.admin && liveAuthorTurn) {
      const status = await deps.admin
        .adminStatusOf(actor)
        .catch(swallowAs("orchestrator: admin status for turn", { isAdmin: false }));
      actorIsOrgAdmin = status.isAdmin;
    }
    const turnSurface = input.surface === "web" ? "web" : (session.surface ?? input.surface);
    controlClaims = {
      ...scopeAttestation,
      aud: CONTROL_PLANE_AUD,
      ...(!external &&
      allInternal &&
      (scopeId === personalScope(actor.id) || openSpeakerKeychain || openAutomationKeychain)
        ? { ownerConnections: true }
        : {}),
      exp: sandboxTokenExpiry,
      ...(turnTimezone ? { timezone: turnTimezone } : {}),
      ...(destination ? { destination } : {}),
      ...(delivery.candidates.length > 0 ? { destinations: delivery.candidates } : {}),
      ...(delivery.defaultKey ? { defaultDestinationKey: delivery.defaultKey } : {}),
      ...(!external && conversation.kind !== "dm"
        ? { keychainMembers: conversation.audience.filter((p) => p.type === "internal") }
        : {}),
      ...(conversation.kind === "dm" ||
      conversation.kind === "group" ||
      conversation.isPrivate === true ||
      conversation.isMpim === true
        ? { privateScope: true }
        : {}),
      ...(liveAuthorTurn ? { liveAuthor: true } : {}),
      ...(automatedTurn ? { triggered: true } : {}),
      ...(!liveTurn && input.unattendedGrants ? { grants: input.unattendedGrants } : {}),
      ...(input.runId ? { runId: input.runId } : {}),
      sessionId: session.id,
      runAttempt: input.attempt,
      runLeaseToken: input.runLeaseToken,
      threadRef: conversation.threadRef,
      ...(turnSurface ? { surface: turnSurface } : {}),
    };
    connectorEnv.AGENT_API_TOKEN = await mintCapabilityToken(
      controlClaims,
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
    if (managedBrowse) {
      connectorEnv.BROWSE_LAB_BASE_URL = `${deps.apiBaseUrl.replace(/\/+$/, "")}/v1/browser-model`;
      connectorEnv.BROWSE_LAB_MODEL_TOKEN = await mintCapabilityToken(
        {
          ...scopeAttestation,
          aud: BROWSER_MODEL_AUD,
          browserModel: browserSelection.model ?? "unavailable",
          browserAccount: browserSelection.account,
          exp: Date.now() + CAPABILITY_TTL_MS,
        },
        deps.capabilitySecret ?? deps.signingSecret,
      );
    }
    if (deps.sandboxModels && allInternal) {
      connectorEnv.MODEL_GATEWAY_URL = `${deps.apiBaseUrl.replace(/\/+$/, "")}${SANDBOX_MODEL_PREFIX}`;
      connectorEnv.MODEL_GATEWAY_TOKEN = await mintCapabilityToken(
        { ...scopeAttestation, aud: SANDBOX_MODEL_AUD, exp: sandboxTokenExpiry },
        deps.capabilitySecret ?? deps.signingSecret,
        deps.capabilityTokenCompression,
      );
      sandboxModelGateway = true;
    }
    connectorEnv.AGENT_OAUTH_CONSENT_TOKEN = await mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: OAUTH_CONSENT_AUD,
        exp: sandboxTokenExpiry,
      },
      deps.capabilitySecret ?? deps.signingSecret,
      deps.capabilityTokenCompression,
    );
  }
  const egressSecret = deps.capabilitySecret ?? deps.signingSecret;
  const egressTokenForPolicy = async (egress: EgressPolicy): Promise<string | undefined> => {
    if (strictReadOnly || !egressSecret) return undefined;
    return mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: EGRESS_PROXY_AUD,
        egress: egressClaimAllowingControlPlane(egress, deps.apiBaseUrl ?? ""),
        exp: sandboxTokenExpiry,
      },
      egressSecret,
      deps.capabilityTokenCompression,
    );
  };
  const egressTokenForTurn = await egressTokenForPolicy(resolution.egress);
  const mintBrokerToken = (credentials: string[], connectors: BrokeredConnector[]): Promise<string> =>
    mintCapabilityToken(
      {
        ...scopeAttestation,
        aud: CREDENTIAL_BROKER_AUD,
        ...(external
          ? {
              runId: input.runId,
              runAttempt: input.attempt,
              runLeaseToken: input.runLeaseToken,
              threadRef: conversation.threadRef,
            }
          : {}),
        credentials,
        ...(connectors.length ? { connectors } : {}),
        exp: sandboxTokenExpiry,
      },
      (deps.capabilitySecret ?? deps.signingSecret)!,
      deps.capabilityTokenCompression,
    );
  const registerServiceCredentials = async (
    addCredential: typeof addCredentialToCatalog,
    broker: CredentialBroker,
  ): Promise<void> => {
    if (strictReadOnly || !deps.serviceCreds) return;
    const records = (await deps.serviceCreds.listServiceCredentials(resolution.orgScopeId)).filter((record) =>
      serviceAllowed(record.slug),
    );
    const granted = await grantedServiceCredSlugs(records);
    const available = records.filter(
      (record) => !isBackendCredential(record) && record.enabled && record.hasSecret && granted.has(record.slug),
    );
    for (const credential of available) {
      if (credential.delivery === "env") {
        if ((!allInternal && !external) || !credential.envKey) continue;
        addCredential(
          {
            handle: credential.slug,
            resolve: async () => {
              await authorizeServiceCredential(credential.slug);
              const current = await deps.serviceCreds!.getServiceCredentialSecret(
                resolution.orgScopeId,
                credential.slug,
              );
              if (
                !current?.enabled ||
                isBackendCredential(current) ||
                !current.secret ||
                current.delivery !== "env" ||
                current.envKey !== credential.envKey
              ) {
                throw new Error(`Service credential is no longer available: ${credential.slug}`);
              }
              return { env: [{ key: credential.envKey!, value: current.secret }] };
            },
          },
          `${credential.name}; provides ${credential.envKey}`,
          undefined,
          "Organization",
        );
      } else if (brokerAvailable) {
        broker.service(credential.slug);
        addCredential(
          {
            handle: credential.slug,
            resolve: async () => {
              await authorizeServiceCredential(credential.slug);
              const record = (await deps.serviceCreds!.listServiceCredentials(resolution.orgScopeId)).find(
                (candidate) => candidate.slug === credential.slug,
              );
              if (!record?.enabled || !record.hasSecret || record.delivery === "env") {
                throw new Error(`Service credential is no longer available: ${credential.slug}`);
              }
              return { env: await broker.env() };
            },
          },
          `${credential.name}; proxy ${credential.host}; ${(credential.allowedMethods?.length ? credential.allowedMethods : ["GET"]).toSorted().join("/")}; ${credential.allowedPathPrefixes?.length ? `paths ${credential.allowedPathPrefixes.toSorted().join(", ")}` : "any path"}; use the use-shared-credential skill`,
          undefined,
          "Organization",
        );
      }
    }
  };
  await registerServiceCredentials(addCredentialToCatalog, catalogBroker);
  if (!strictReadOnly && actor.type === "internal") {
    for (const tool of brokeredTools) {
      const broker = deps.layerBrokerFor?.(tool);
      if (!broker) continue;
      addCredentialToCatalog(
        {
          handle: `broker_${tool.service}`,
          resolve: async () => {
            let aws;
            try {
              aws = await broker.credsForActor(actor.id);
            } catch (e) {
              deps.credentialUsage?.record({
                slug: tool.service,
                host: "sts.amazonaws.com",
                status: "unavailable",
                scopeLabel: scopeId,
                principalId: actor.id,
              });
              throw new Error(`Could not vend credentials for ${tool.service}`, { cause: e });
            }
            deps.credentialUsage?.record({
              slug: tool.service,
              host: "sts.amazonaws.com",
              status: "vended",
              scopeLabel: scopeId,
              principalId: actor.id,
            });
            return {
              env: Object.entries({
                AWS_ACCESS_KEY_ID: aws.accessKeyId,
                AWS_SECRET_ACCESS_KEY: aws.secretAccessKey,
                AWS_SESSION_TOKEN: aws.sessionToken,
                AWS_REGION: aws.region,
                AWS_DEFAULT_REGION: aws.region,
              }).map(([key, value]) => ({
                key,
                value,
                secret: key !== "AWS_REGION" && key !== "AWS_DEFAULT_REGION",
              })),
            };
          },
        },
        `${tool.service}, role broker for ${actor.id}`,
      );
    }
  }
  return {
    openSpeakerKeychain,
    ownerAuthAvailable,
    connectorEnv,
    commandCredentials,
    credentialDescriptions,
    credentialBroker,
    registerKeychainCredentials,
    registerConnectorCredentials,
    serviceCredRecords,
    grantedCredSlugs,
    actorIsOrgAdmin,
    controlClaims,
    scopeAttestation,
    egressTokenForPolicy,
    egressTokenForTurn,
    registerServiceCredentials,
    openAutomationKeychain,
    sandboxModelGateway,
  };
}
