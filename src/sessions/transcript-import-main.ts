import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { loadConfig } from "../config.ts";
import { createPostgresSessionStore } from "./postgres-session-store.ts";
import { importTranscripts } from "./transcript-import.ts";

const file = process.argv[2];
if (!file) throw new Error("usage: node src/sessions/transcript-import-main.ts <file.ndjson>");
const config = loadConfig();
if (!config.databaseUrl) throw new Error("DATABASE_URL is required");
const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
for await (const result of importTranscripts(createPostgresSessionStore(config.databaseUrl), lines))
  console.log(JSON.stringify({ threadRef: result.threadRef, sessionId: result.session.id, appended: result.appended }));
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
