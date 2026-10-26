import { readFileSync } from "node:fs";
import { loadConfig } from "../config.ts";
import { createPostgresSessionStore } from "./postgres-session-store.ts";
import { importTranscripts } from "./transcript-import.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node src/sessions/transcript-import-main.ts <file.ndjson>");
const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const results = await importTranscripts(
  createPostgresSessionStore(config.databaseUrl),
  readFileSync(file, "utf8").split("\n"),
);
for (const result of results)
  console.log(JSON.stringify({ threadRef: result.threadRef, sessionId: result.session.id, appended: result.appended }));
process.exit(0);
