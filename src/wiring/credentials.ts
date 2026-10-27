import { createEnvSecretSource } from "../credentials/secret-source.ts";
import { type OAuthClientResolver, withPublicOAuthClients, makeRefresh, type OAuthState } from "../connectors/oauth.ts";
import {
  createConnectorClientResolver,
  deriveConnectorKey,
  type SecretKey,
} from "../connectors/connector-client-store.ts";
import { scopeId } from "../types.ts";
import {
  type Keychain,
  createKeychain,
  type KeychainCredential,
  type KeychainGrant,
  type KeychainAsk,
  type OAuthToken,
} from "../credentials/keychain.ts";
import { refreshChatGPTTokens, refreshClaudeTokens } from "../model/subscription-oauth.ts";
import { createUserModelCredentialStore } from "../model/user-model-credential-store.ts";
import { withDeploymentCredentials } from "../credentials/deployment-credentials.ts";
import type { Config } from "../config.ts";
import { errMessage } from "../util/errors.ts";
import { createMcpToolService } from "../mcp/mcp-tool-service.ts";
import {
  type BrowserSessionStore,
  createBrowserSessionStore,
  type StoredBrowserSession,
} from "../connectors/browser-session-store.ts";
import { type ConsentLinkStore, createConsentLinkStore, type ConsentLinkRecord } from "../connectors/consent-link.ts";
import { type OAuthFlowStore, createOAuthFlowStore } from "../connectors/oauth-flow-store.ts";
import { type SecretDropStore, createSecretDropStore, type SecretDropRecord } from "../credentials/secret-drop.ts";
import { createModelGateway } from "../model/model-gateway.ts";
import type { AppOverrides } from "../wiring.ts";
import type { Stores } from "./stores.ts";
import type { Files } from "./files.ts";
import type { DeploymentLayer } from "./deployment-layer.ts";

export function buildCredentials(
  w: Pick<Stores, "artifactMap" | "advisoryLock" | "configStore"> &
    Pick<Files, "mcpServers"> &
    Pick<DeploymentLayer, "auditLog"> & { config: Config; overrides: AppOverrides; connectorSecretKey: string },
) {
  const { overrides, configStore, config, connectorSecretKey, artifactMap, advisoryLock, mcpServers, auditLog } = w;

  const secretSource = createEnvSecretSource(overrides.env);
  const resolveClient: OAuthClientResolver = withPublicOAuthClients(
    createConnectorClientResolver({
      reader: configStore,
      orgScopeId: (o) => scopeId("org", o),
      secrets: secretSource,
    }),
  );
  const legacyCredentialKey =
    config.signingSecret && config.signingSecret !== connectorSecretKey
      ? deriveConnectorKey(config.signingSecret, "keychain")
      : undefined;
  const credentialKey: SecretKey = {
    ...deriveConnectorKey(connectorSecretKey, "keychain"),
    ...(legacyCredentialKey ? { fallbacks: [legacyCredentialKey] } : {}),
  };
  const credentialStore: Keychain = createKeychain({
    creds: artifactMap<KeychainCredential>("keychain_credentials", ["ownerId"]),
    grants: artifactMap<KeychainGrant>("keychain_grants", ["ownerId"]),
    asks: artifactMap<KeychainAsk>("keychain_asks"),
    key: credentialKey,
    lock: advisoryLock,
    refreshConnector: (() => {
      const base = makeRefresh({ resolveClient });
      // AI subscription logins ride the same connector-refresh machinery:
      // the keychain calls this single-flight when a token is stale.
      return async (host: string, token: OAuthToken, ctx?: { accountType?: string; clientRef?: string }) => {
        if (token.refreshToken && host === "auth.openai.com") {
          const fresh = await refreshChatGPTTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        if (token.refreshToken && host === "claude.ai") {
          const fresh = await refreshClaudeTokens(token.refreshToken);
          return oauthTokenFromUserTokens(fresh);
        }
        return base(host, token, ctx);
      };
    })(),
  });
  const oauthTokenFromUserTokens = (fresh: {
    accessToken: string;
    refreshToken?: string;
    idToken?: string;
    accountId?: string;
    expiresAt?: number;
  }): OAuthToken => ({
    accessToken: fresh.accessToken,
    ...(fresh.refreshToken ? { refreshToken: fresh.refreshToken } : {}),
    ...(fresh.idToken ? { idToken: fresh.idToken } : {}),
    ...(fresh.accountId ? { accountId: fresh.accountId } : {}),
    ...(fresh.expiresAt !== undefined ? { expiresAt: fresh.expiresAt } : {}),
  });
  // Per-user AI accounts live in the keychain itself (unified custody):
  // same encryption, ownership, admin visibility, and removal flows as
  // every other personal credential.
  const userModelCredentials = createUserModelCredentialStore({ keychain: credentialStore });
  const keychain: Keychain = credentialStore;
  const serviceCreds = withDeploymentCredentials(
    credentialStore,
    scopeId("org", config.orgId),
    config.brokerCredentials ?? [],
  );
  const warnShadowedBrokerCredentials = (brokerCredentials: NonNullable<Config["brokerCredentials"]>) => {
    const reserved = new Set(brokerCredentials.map((c) => c.slug));
    void credentialStore.listServiceCredentials(scopeId("org", config.orgId)).then(
      (stored) => {
        const shadowed = stored.filter((c) => reserved.has(c.slug)).map((c) => c.slug);
        if (shadowed.length)
          console.warn(`[broker-credentials] BROKER_CREDENTIALS overrides stored credentials: ${shadowed.join(", ")}`);
      },
      (error) =>
        console.warn(`[broker-credentials] could not check for overridden stored credentials: ${errMessage(error)}`),
    );
  };
  const mcpToolService = createMcpToolService({
    servers: mcpServers,
    audit: auditLog,
    userTokens: keychain,
    ...(config.publicWebUrl
      ? {
          signInUrl: (id: string) =>
            `${config.publicWebUrl!.replace(/\/$/, "")}/connect/${encodeURIComponent(id)}/self-connect`,
        }
      : {}),
  });
  const browserSessionStore: BrowserSessionStore = createBrowserSessionStore({
    sessions: artifactMap<StoredBrowserSession>("browser_sessions"),
    key: credentialKey,
  });
  const connectorTokens = credentialStore;
  const consentLinks: ConsentLinkStore = createConsentLinkStore(artifactMap<ConsentLinkRecord>("consent_links"));
  const oauthFlows: OAuthFlowStore = createOAuthFlowStore(artifactMap<OAuthState>("oauth_flows"));
  const secretDrops: SecretDropStore = createSecretDropStore(artifactMap<SecretDropRecord>("secret_drops"));
  const modelGateway = createModelGateway();
  return {
    warnShadowedBrokerCredentials,
    keychain,
    serviceCreds,
    userModelCredentials,
    connectorTokens,
    modelGateway,
    mcpToolService,
    resolveClient,
    consentLinks,
    oauthFlows,
    secretDrops,
    browserSessionStore,
  };
}

export type Credentials = ReturnType<typeof buildCredentials>;
