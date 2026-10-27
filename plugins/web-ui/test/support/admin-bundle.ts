import { buildSync } from "esbuild";

export const adminBundle = (module: string, globalName: string) =>
  buildSync({
    entryPoints: [new URL(`../../src/admin/${module}`, import.meta.url).pathname],
    bundle: true,
    write: false,
    format: "iife",
    globalName,
    platform: "browser",
  }).outputFiles[0]!.text;
