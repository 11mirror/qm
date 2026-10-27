import { test } from "node:test";
import { BROWSER_SESSIONS_MIGRATION } from "../../src/connectors/browser-session-store.ts";
import { CONSENT_LINKS_MIGRATION } from "../../src/connectors/consent-link.ts";
import { OAUTH_FLOWS_MIGRATION } from "../../src/connectors/oauth-flow-store.ts";
import { CONNECTOR_STATUS_MIGRATION } from "../../src/credentials/connector-status.ts";
import {
  KEYCHAIN_ASKS_MIGRATION,
  KEYCHAIN_CREDENTIALS_MIGRATION,
  KEYCHAIN_GRANTS_MIGRATION,
} from "../../src/credentials/keychain-store.ts";
import { SECRET_DROPS_MIGRATION } from "../../src/credentials/secret-drop.ts";
import { CUSTOM_PROVIDERS_MIGRATION } from "../../src/model/custom-provider-store.ts";
import { MODEL_CREDENTIALS_MIGRATION } from "../../src/model/model-credential-store.ts";
import { assertMapConversion } from "../support/map-conversion.ts";

const CONVERSIONS = [
  KEYCHAIN_CREDENTIALS_MIGRATION,
  KEYCHAIN_GRANTS_MIGRATION,
  KEYCHAIN_ASKS_MIGRATION,
  MODEL_CREDENTIALS_MIGRATION,
  CUSTOM_PROVIDERS_MIGRATION,
  CONNECTOR_STATUS_MIGRATION,
  SECRET_DROPS_MIGRATION,
  CONSENT_LINKS_MIGRATION,
  OAUTH_FLOWS_MIGRATION,
  BROWSER_SESSIONS_MIGRATION,
];

for (const conversion of CONVERSIONS)
  test(`${conversion.spec.table} converts in place for one tenant and for two`, () => assertMapConversion(conversion));
