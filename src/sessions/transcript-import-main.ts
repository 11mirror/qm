import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { createPostgresSessionStore } from "./postgres-session-store.ts";
import { importTranscripts } from "./transcript-import.ts";

const file = process.argv[2];
const databaseUrl = process.env.DATABASE_URL;
if (!file || !databaseUrl)
  throw new Error("usage: DATABASE_URL=… node src/sessions/transcript-import-main.ts <file.ndjson>");
const lines = createInterface({ input: createReadStream(file, "utf8"), crlfDelay: Infinity });
for await (const result of importTranscripts(createPostgresSessionStore(databaseUrl), lines))
  console.log(JSON.stringify({ threadRef: result.threadRef, sessionId: result.session.id, appended: result.appended }));
await new Promise<void>((resolve) => process.stdout.write("", () => resolve()));
process.exit(0);
