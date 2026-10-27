import { test } from "node:test";
import { CONFIG_TABLE_MIGRATIONS } from "../src/resolution/config-tables.ts";
import { assertMapConversion } from "./support/map-conversion.ts";

for (const conversion of CONFIG_TABLE_MIGRATIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));
