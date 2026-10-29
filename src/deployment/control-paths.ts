const PATHS = new Set(["/v1/background-work", "/v1/deployment/live-session"]);

export const deploymentControlPath = (pathname: string): boolean => PATHS.has(pathname);
