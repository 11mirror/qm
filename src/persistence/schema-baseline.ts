import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

export interface SchemaBaselineStep {
  id: string;
  checksum: string;
  statements: readonly string[];
  prepare?: readonly string[];
  legacyId?: string;
}

interface SchemaBaselineChain {
  before: readonly SchemaBaselineStep[];
  migrations: readonly SchemaBaselineStep[];
  after: readonly SchemaBaselineStep[];
}

const sql = readFileSync(new URL("./schema-baseline.sql", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const checksum = createHash("sha256").update(sql).digest("hex");
const EXPECTED_CHECKSUM = "ce6b6272ae4d2f1f5d7737323fe3e9a57feb3f12d0abc3c6f00f7b052f41c2ce";
if (checksum !== EXPECTED_CHECKSUM) {
  throw new Error(
    `schema-baseline.sql changed (expected=${EXPECTED_CHECKSUM}, actual=${checksum}); add a migration instead`,
  );
}

const chain = JSON.parse(
  readFileSync(new URL("./schema-baseline-chain.json", import.meta.url), "utf8"),
) as SchemaBaselineChain;

export const SCHEMA_BASELINE = { id: "baseline/0001", sql, checksum, chain } as const;
