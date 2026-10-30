import type { FinnyCapabilityCatalog, FinnyCapabilityDescriptor } from "./capability-pack.ts";
import { resolveFinnyIntent, type FinnyIntentResolution, type FinnyResolvedDimensions } from "./intent-resolver.ts";
import { compileFinnyOperationPlan, type FinnyOperationPlan } from "./operation-compiler.ts";

export type FinnyControllerCompilation =
  | {
      status: "compiled";
      request: string;
      semanticCapability: string;
      dimensions: FinnyResolvedDimensions;
      plan: FinnyOperationPlan;
    }
  | Exclude<FinnyIntentResolution, { status: "resolved" }>;

function declaredDimensions(
  descriptor: FinnyCapabilityDescriptor,
  dimensions: FinnyResolvedDimensions,
): Record<string, unknown> {
  const source = dimensions as unknown as Record<string, unknown>;
  const names = new Set([...descriptor.dimensions.required, ...Object.keys(descriptor.dimensions.supported)]);
  return Object.fromEntries(
    [...names]
      .sort()
      .filter((name) => Object.hasOwn(source, name) || Object.hasOwn(descriptor.dimensions.defaults, name))
      .map((name) => {
        const value = source[name];
        const useDefault = value === undefined || (Array.isArray(value) && value.length === 0);
        return [name, useDefault ? descriptor.dimensions.defaults[name] : value];
      }),
  );
}

export function compileFinnyControllerRequest(
  request: string,
  catalog: FinnyCapabilityCatalog,
): FinnyControllerCompilation {
  const resolution = resolveFinnyIntent(request, catalog);
  if (resolution.status !== "resolved") return resolution;
  return {
    status: "compiled",
    request: resolution.request,
    semanticCapability: resolution.semanticCapability,
    dimensions: resolution.dimensions,
    plan: compileFinnyOperationPlan({
      descriptor: resolution.capability,
      manifestDigest: catalog.manifestDigest,
      catalogDigest: catalog.catalogDigest,
      semanticCapability: resolution.semanticCapability,
      dimensions: declaredDimensions(resolution.capability, resolution.dimensions),
    }),
  };
}
