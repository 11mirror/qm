import { existsSync } from "node:fs";

export function templateUrl(rel: string): URL {
  const source = new URL(`../templates/${rel}`, import.meta.url);
  return existsSync(source) ? source : new URL(`../../templates/${rel}`, import.meta.url);
}
