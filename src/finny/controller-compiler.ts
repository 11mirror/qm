import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "./capability-pack.ts";
import {
  resolveFinnyIntent,
  type FinnyIntentCandidate,
  type FinnyIntentResolution,
  type FinnyResolvedDimensions,
} from "./intent-resolver.ts";
import { compileFinnyOperationPlan, type FinnyOperationPlan } from "./operation-compiler.ts";

export type FinnyControllerCompilation =
  | {
      status: "compiled";
      capabilityId: string;
      semanticCapability: string;
      dimensions: FinnyResolvedDimensions;
      artifactFormat?: FinnyCapabilityDescriptor["artifactPolicy"]["allowedFormats"][number];
      plan: FinnyOperationPlan;
    }
  | Exclude<FinnyIntentResolution, { status: "resolved" }>;

export function compileFinnyControllerRequest(
  candidate: FinnyIntentCandidate,
  catalog: FinnyCapabilityCatalog,
): FinnyControllerCompilation {
  const resolution = resolveFinnyIntent(candidate, catalog);
  if (resolution.status !== "resolved") return resolution;
  return {
    status: "compiled",
    capabilityId: resolution.capabilityId,
    semanticCapability: resolution.semanticCapability,
    dimensions: resolution.dimensions,
    ...(resolution.artifactFormat ? { artifactFormat: resolution.artifactFormat } : {}),
    plan: compileFinnyOperationPlan({
      descriptor: resolution.capability,
      manifestDigest: catalog.manifestDigest,
      catalogDigest: catalog.catalogDigest,
      semanticCapability: resolution.semanticCapability,
      dimensions: resolution.dimensions,
      ...(resolution.artifactFormat ? { artifactFormat: resolution.artifactFormat } : {}),
    }),
  };
}
