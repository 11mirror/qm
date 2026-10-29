import { sandboxScopeName } from "./exec-sandbox-base.ts";
export const sandboxSiblingName = (kind: "home" | "net", containerName: string, prefix: string): string =>
  `${prefix}-${kind}-${containerName.slice(prefix.length + 1)}`;
export const sandboxContainerName = (scopeId: string, prefix = "qm"): string => sandboxScopeName(prefix, scopeId);
export const sandboxVolumeName = (scopeId: string, prefix = "qm"): string =>
  sandboxSiblingName("home", sandboxContainerName(scopeId, prefix), prefix);
export const sandboxNetworkName = (containerName: string, prefix = "qm"): string =>
  sandboxSiblingName("net", containerName, prefix);
