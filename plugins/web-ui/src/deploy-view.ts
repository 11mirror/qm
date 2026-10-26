interface DeploymentVersionView {
  version: number;
  createdAt: number;
  commit?: string;
  parentCommit?: string;
}

export interface DeploymentView {
  id: string;
  status?: "running" | "stopped" | "archived" | string;
  ownerScopeId?: string;
  createdBy?: string;
  createdInScope?: string;
  currentVersion?: number;
  appliedVersion?: number;
  webUrl?: string;
  gitUrl?: string;
  name?: string;
  displayName?: string;
  permission?: "read" | "write";
  embedAncestors?: string[];
  public?: boolean;
  createdAt?: number;
  updatedAt?: number;
  lastAccessAt?: number;
  versions?: DeploymentVersionView[];
}

export type DeploymentTab = "yours" | "shared" | "archived";

export function deploymentCanManage(d: DeploymentView): boolean {
  return d.permission === "write";
}

export function deploymentInScope(d: DeploymentView, scope: string | null): boolean {
  return !scope || d.createdInScope === scope || d.ownerScopeId === scope;
}

export function deploymentTitle(d: DeploymentView): string {
  return d.displayName?.trim() || d.name?.trim() || d.id;
}

export function deploymentSlug(d: DeploymentView): string {
  return d.name?.trim() || d.id;
}

export function deploymentLatestAt(d: DeploymentView): number {
  const applied = d.versions?.find((version) => version.version === (d.appliedVersion ?? d.currentVersion));
  return applied?.createdAt ?? d.versions?.at(-1)?.createdAt ?? 0;
}

export function deploymentTab(d: DeploymentView, viewer: string | undefined): DeploymentTab {
  if (d.status === "archived") return "archived";
  if (!viewer) return "shared";
  if (d.ownerScopeId === `personal:${viewer}`) return "yours";
  return !d.ownerScopeId?.startsWith("personal:") && d.createdBy === viewer ? "yours" : "shared";
}

export function filterDeployments(
  deployments: DeploymentView[],
  options: { tab: DeploymentTab; scope: string | null; query: string; viewer?: string },
): DeploymentView[] {
  const query = options.query.trim().toLocaleLowerCase();
  return deployments
    .filter((d) => deploymentTab(d, options.viewer) === options.tab)
    .filter((d) => deploymentInScope(d, options.scope))
    .filter((d) => {
      if (!query) return true;
      return [deploymentTitle(d), deploymentSlug(d), d.createdBy, d.createdInScope, d.ownerScopeId, d.status].some(
        (value) => value?.toLocaleLowerCase().includes(query),
      );
    })
    .sort(
      (a, b) => deploymentLatestAt(b) - deploymentLatestAt(a) || deploymentTitle(a).localeCompare(deploymentTitle(b)),
    );
}

export function friendlyPrincipal(principal: string | undefined): string {
  const local = (principal ?? "").split("@")[0]!.trim();
  if (!local) return "Unknown owner";
  return local
    .split(/[._-]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toLocaleUpperCase() + part.slice(1))
    .join(" ");
}
