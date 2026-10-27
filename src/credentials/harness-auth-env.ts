import type { Keychain } from "./keychain.ts";
import { reportFailure } from "../util/errors.ts";

export function keychainHarnessAuthEnv(
  keychain: Keychain,
  credentialId: string,
  allowedEnvKeys: readonly string[],
): () => Promise<NodeJS.ProcessEnv> {
  return async () => {
    try {
      const meta = await keychain.getCredential(credentialId);
      if (!meta || meta.kind !== "env") return {};
      if (typeof meta.expiresAt === "number" && meta.expiresAt < Date.now()) return {};
      const creds = await keychain.materializeOwn(meta.ownerId);
      const cred = creds.find((c) => c.credentialId === credentialId);
      if (!cred) return {};
      const env: NodeJS.ProcessEnv = {};
      for (const { key, value } of cred.env) {
        if (allowedEnvKeys.includes(key)) env[key] = value;
      }
      return env;
    } catch (e) {
      reportFailure("keychain: harness credential unreadable", e, credentialId);
      return {};
    }
  };
}
