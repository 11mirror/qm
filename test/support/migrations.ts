import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

export const migrate = (url: string) =>
  exec(process.execPath, ["src/migrate-main.ts"], {
    cwd: new URL("../..", import.meta.url),
    timeout: 120_000,
    env: {
      PATH: process.env.PATH,
      NODE_ENV: "test",
      DATABASE_URL: url,
      SANDBOX_BACKEND: "local",
      ORG_ID: "o",
      CONNECTOR_SECRET_KEY: "test-connector-secret-0123456789abcdef",
    },
  });
