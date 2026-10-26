import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";

const created: Array<{ server: string; name: string }> = [];

const ADMIN_SCRIPT = `
import pg from "pg";
const [, server, action, names] = process.argv;
const client = new pg.Client({ connectionString: server });
await client.connect();
try {
  for (const name of names.split(",")) {
    const ident = '"' + name.replaceAll('"', '""') + '"';
    await client.query(action === "create" ? "CREATE DATABASE " + ident : "DROP DATABASE IF EXISTS " + ident + " WITH (FORCE)");
  }
} finally {
  await client.end();
}
`;

function adminArgs(server: string, action: "create" | "drop", names: string): string[] {
  return ["--input-type=module", "-e", ADMIN_SCRIPT, server, action, names];
}

function serverUrl(): string {
  const url = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error("Set TEST_DATABASE_URL to a Postgres server: QM keeps sessions and turns in Postgres");
  return url;
}

function withDatabase(server: string, name: string): string {
  const url = new URL(server);
  url.pathname = `/${name}`;
  return url.toString();
}

function dropCreatedInBackground(): void {
  for (const [server, dbs] of Map.groupBy(created, (db) => db.server)) {
    spawn(process.execPath, adminArgs(server, "drop", dbs.map((db) => db.name).join(",")), {
      detached: true,
      stdio: "ignore",
    }).unref();
  }
}

export function freshTestDatabase(): string {
  const server = serverUrl();
  const name = `qmt_${process.pid}_${randomBytes(4).toString("hex")}`;
  if (!created.length) process.once("exit", dropCreatedInBackground);
  execFileSync(process.execPath, adminArgs(server, "create", name), { stdio: ["ignore", "ignore", "inherit"] });
  created.push({ server, name });
  return withDatabase(server, name);
}
