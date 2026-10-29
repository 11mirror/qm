export function parseAllowedOrigins(raw: string | undefined): { origins: Set<string>; problems: string[] } {
  const origins = new Set<string>();
  const problems: string[] = [];
  for (const entry of (raw ?? "").split(",").map((part) => part.trim())) {
    if (!entry) continue;
    let url: URL;
    try {
      url = new URL(entry);
    } catch {
      problems.push(`PORTAL_API_ALLOWED_ORIGINS entry "${entry}" is not a URL`);
      continue;
    }
    if (url.origin !== entry) {
      problems.push(
        `PORTAL_API_ALLOWED_ORIGINS entry "${entry}" must be a bare origin (scheme, host and optional port, no path or trailing slash), e.g. "${url.origin}"`,
      );
      continue;
    }
    if (url.protocol !== "https:" && url.hostname !== "localhost" && url.hostname !== "127.0.0.1") {
      problems.push(`PORTAL_API_ALLOWED_ORIGINS entry "${entry}" must use https`);
      continue;
    }
    origins.add(url.origin);
  }
  return { origins, problems };
}
