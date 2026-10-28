import type { DerivedOAuthAuth, Keychain } from "../credentials/keychain.ts";

const PERSONAL_MODEL_PROVIDERS = ["anthropic", "openai"] as const;
export type PersonalModelProvider = (typeof PERSONAL_MODEL_PROVIDERS)[number];

export function isPersonalModelProvider(value: unknown): value is PersonalModelProvider {
  return PERSONAL_MODEL_PROVIDERS.some((provider) => provider === value);
}

type UserCredentialKind = "apikey" | "oauth";

export interface UserOAuthTokens {
  accessToken: string;
  refreshToken?: string;
  idToken?: string;
  accountId?: string;
  expiresAt?: number;
}

export interface UserModelCredential {
  provider: PersonalModelProvider;
  kind: UserCredentialKind;
  apiKey?: string;
  oauth?: { accountId?: string; expiresAt?: number; needsReconnect?: boolean };
  updatedAt: number;
}

interface UserCredentialConnection {
  provider: PersonalModelProvider;
  kind: UserCredentialKind;
}

export interface UserModelCredentialStore {
  get(userId: string, provider: PersonalModelProvider): Promise<UserModelCredential | null>;
  connections(userId: string): Promise<UserCredentialConnection[]>;
  setApiKey(userId: string, provider: PersonalModelProvider, apiKey: string): Promise<void>;
  setOAuth(userId: string, provider: PersonalModelProvider, tokens: UserOAuthTokens): Promise<void>;
  derivedOAuth(userId: string, provider: PersonalModelProvider): Promise<DerivedOAuthAuth | null>;
  delete(userId: string, provider: PersonalModelProvider): Promise<void>;
}

const ORIGIN = "individual-model-auth";
const AI_OAUTH_HOSTS: Record<PersonalModelProvider, string> = {
  anthropic: "claude.ai",
  openai: "auth.openai.com",
};
const AI_ACCOUNT_TYPE = "individual-model";

function serviceFor(provider: PersonalModelProvider): string {
  return `model-${provider}`;
}

export function createUserModelCredentialStore(input: { keychain: Keychain }): UserModelCredentialStore {
  const { keychain } = input;

  async function findApiKey(userId: string, provider: PersonalModelProvider) {
    const all = await keychain.listByOwner(userId);
    return all.find((c) => c.service === serviceFor(provider) && c.origin === ORIGIN) ?? null;
  }

  async function oauthCredential(userId: string, provider: PersonalModelProvider): Promise<UserModelCredential | null> {
    const status = await keychain.connectorTokenStatus(AI_OAUTH_HOSTS[provider], userId, AI_ACCOUNT_TYPE);
    if (!status.connected) return null;
    return {
      provider,
      kind: "oauth",
      oauth: {
        ...(status.expiresAt !== undefined ? { expiresAt: status.expiresAt } : {}),
        ...(status.needsReconnect ? { needsReconnect: true } : {}),
      },
      updatedAt: 0,
    };
  }

  async function apiKeyCredential(
    userId: string,
    provider: PersonalModelProvider,
  ): Promise<UserModelCredential | null> {
    const meta = await findApiKey(userId, provider);
    if (!meta) return null;
    const apiKey = await keychain.readOwnSecret(userId, meta.id);
    if (!apiKey) return null;
    return { provider, kind: "apikey", apiKey, updatedAt: meta.updatedAt };
  }

  return {
    async get(userId, provider) {
      return (await oauthCredential(userId, provider)) ?? (await apiKeyCredential(userId, provider));
    },

    async connections(userId) {
      const [owned, ...subscriptions] = await Promise.all([
        keychain.listByOwner(userId),
        ...PERSONAL_MODEL_PROVIDERS.map((provider) =>
          keychain.connectorTokenStatus(AI_OAUTH_HOSTS[provider], userId, AI_ACCOUNT_TYPE),
        ),
      ]);
      const apiKeys = new Set(owned.filter((c) => c.origin === ORIGIN).map((c) => c.service));
      return PERSONAL_MODEL_PROVIDERS.flatMap((provider, i): UserCredentialConnection[] => {
        if (subscriptions[i]?.connected) return [{ provider, kind: "oauth" }];
        return apiKeys.has(serviceFor(provider)) ? [{ provider, kind: "apikey" }] : [];
      });
    },

    async setApiKey(userId, provider, apiKey) {
      const secret = apiKey.trim();
      if (!secret) throw new Error("API key is required");
      await keychain.deleteConnectorToken(AI_OAUTH_HOSTS[provider], userId, AI_ACCOUNT_TYPE);
      await keychain.save({ ownerId: userId, service: serviceFor(provider), secret, origin: ORIGIN });
    },

    async setOAuth(userId, provider, tokens) {
      if (!tokens.accessToken?.trim()) throw new Error("access token is required");
      await keychain.setConnectorToken(
        AI_OAUTH_HOSTS[provider],
        userId,
        {
          accessToken: tokens.accessToken,
          ...(tokens.refreshToken ? { refreshToken: tokens.refreshToken } : {}),
          ...(tokens.idToken ? { idToken: tokens.idToken } : {}),
          ...(tokens.accountId ? { accountId: tokens.accountId } : {}),
          ...(tokens.expiresAt !== undefined ? { expiresAt: tokens.expiresAt } : {}),
        },
        AI_ACCOUNT_TYPE,
      );
      const apiKeyMeta = await findApiKey(userId, provider);
      if (apiKeyMeta) await keychain.remove(userId, apiKeyMeta.id);
    },

    async derivedOAuth(userId, provider) {
      return keychain.connectorDerivedAuth(AI_OAUTH_HOSTS[provider], userId, AI_ACCOUNT_TYPE);
    },

    async delete(userId, provider) {
      await keychain.deleteConnectorToken(AI_OAUTH_HOSTS[provider], userId, AI_ACCOUNT_TYPE);
      const meta = await findApiKey(userId, provider);
      if (meta) await keychain.remove(userId, meta.id);
    },
  };
}
