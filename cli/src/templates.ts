import { existsSync } from "node:fs";

/** A file under cli/templates, resolved from source (src/) or the packaged build (dist/src/). */
export function templateUrl(rel: string): URL {
  const source = new URL(`../templates/${rel}`, import.meta.url);
  return existsSync(source) ? source : new URL(`../../templates/${rel}`, import.meta.url);
}
