import type { PublicServiceCredential } from "../credentials/keychain.ts";
import type { ScopeId } from "../types.ts";

export type FinnyCredentialPresence =
  "configured_enabled" | "configured_disabled" | "not_configured" | "credential_store_unavailable";

export interface FinnyDependencyHealth {
  required: boolean;
  presence: FinnyCredentialPresence;
  connectivity: "not_checked";
}

export interface FinnyHealthStatus {
  configuration: "configured" | "blocked_external";
  dependencies: {
    netsuite: FinnyDependencyHealth;
    hindsight: FinnyDependencyHealth;
  };
}

export interface FinnyHealthOptions {
  credentialReader?: FinnyCredentialMetadataReader;
  orgScopeId: ScopeId;
}

export interface FinnyCredentialMetadataReader {
  listServiceCredentials(orgScopeId: ScopeId): Promise<PublicServiceCredential[]>;
}

function presence(credentials: readonly PublicServiceCredential[], slug: string): FinnyCredentialPresence {
  const credential = credentials.find((candidate) => candidate.slug === slug);
  if (!credential) return "not_configured";
  return credential.enabled && credential.hasSecret ? "configured_enabled" : "configured_disabled";
}

export async function readFinnyHealth(options: FinnyHealthOptions): Promise<FinnyHealthStatus> {
  const storeUnavailable = (): FinnyHealthStatus => {
    const dependency = (required: boolean): FinnyDependencyHealth => ({
      required,
      presence: "credential_store_unavailable",
      connectivity: "not_checked",
    });
    return {
      configuration: "blocked_external",
      dependencies: { netsuite: dependency(true), hindsight: dependency(false) },
    };
  };
  if (!options.credentialReader) return storeUnavailable();
  let credentials: readonly PublicServiceCredential[];
  try {
    credentials = await options.credentialReader.listServiceCredentials(options.orgScopeId);
  } catch {
    return storeUnavailable();
  }
  const netsuitePresence = presence(credentials, "finny-netsuite");
  const hindsightPresence = presence(credentials, "finny-hindsight");
  return {
    configuration: netsuitePresence === "configured_enabled" ? "configured" : "blocked_external",
    dependencies: {
      netsuite: { required: true, presence: netsuitePresence, connectivity: "not_checked" },
      hindsight: { required: false, presence: hindsightPresence, connectivity: "not_checked" },
    },
  };
}
