import assert from "node:assert/strict";
import test from "node:test";

import { configuredModelForHarness, loadConfig } from "../src/config.ts";

test("Finny profile is opt-in and pins the Pi runtime and model", () => {
  assert.equal(loadConfig({}).finnyProfile, undefined);

  const config = loadConfig({
    DATABASE_URL: "postgres://localhost/finny_test",
    FINNY_PROFILE: "finny",
    PI_MODEL: "gpt-5.6-sol",
    FINNY_SKILLS_DIR: "/tmp/reviewed-finny-skills",
    SESSION_STORE: "postgres",
    CONNECTOR_SECRET_KEY: "stable-finny-connector-key",
  });

  assert.equal(config.harness, "pi");
  assert.deepEqual(config.finnyProfile, {
    id: "finny",
    modelId: "gpt-5.6-sol",
    skillsDir: "/tmp/reviewed-finny-skills",
  });
  assert.equal(
    configuredModelForHarness(config, "pi"),
    "gpt-5.6-sol",
    "the QM surface and Pi harness must advertise the same Finny-pinned model",
  );
});

test("Finny profile rejects unpinned or incompatible runtime configuration", () => {
  assert.throws(() => loadConfig({ FINNY_PROFILE: "finny" }), /PI_MODEL/);
  assert.throws(
    () => loadConfig({ FINNY_PROFILE: "finny", PI_MODEL: "gpt-5.6-sol", HARNESS: "claude" }),
    /harness=pi/i,
  );
  assert.throws(() => loadConfig({ FINNY_PROFILE: "other", PI_MODEL: "gpt-5.6-sol" }), /FINNY_PROFILE/);
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/finny_test",
        FINNY_PROFILE: "finny",
        PI_MODEL: "gpt-5.6-sol",
        SESSION_STORE: "postgres",
        CONNECTOR_SECRET_KEY: "stable-finny-connector-key",
      }),
    /FINNY_SKILLS_DIR/,
  );
  assert.throws(
    () =>
      loadConfig({
        FINNY_PROFILE: "finny",
        PI_MODEL: "gpt-5.6-sol",
        FINNY_SKILLS_DIR: "/tmp/reviewed-finny-skills",
      }),
    /DATABASE_URL.*SESSION_STORE=postgres.*RUN_STORE=postgres/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/finny_test",
        FINNY_PROFILE: "finny",
        PI_MODEL: "gpt-5.6-sol",
        FINNY_SKILLS_DIR: "/tmp/reviewed-finny-skills",
        SESSION_STORE: "postgres",
        RUN_STORE: "memory",
        CONNECTOR_SECRET_KEY: "stable-finny-connector-key",
      }),
    /RUN_STORE=postgres/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/finny_test",
        FINNY_PROFILE: "finny",
        PI_MODEL: "gpt-5.6-sol",
        FINNY_SKILLS_DIR: "/tmp/reviewed-finny-skills",
        SESSION_STORE: "postgres",
        RUN_STORE: "postgres",
      }),
    /CONNECTOR_SECRET_KEY/,
  );
  assert.throws(
    () =>
      loadConfig({
        DATABASE_URL: "postgres://localhost/finny_test",
        FINNY_PROFILE: "finny",
        PI_MODEL: "gpt-5.6-sol",
        FINNY_SKILLS_DIR: "/tmp/reviewed-finny-skills",
        SESSION_STORE: "postgres",
        CONNECTOR_SECRET_KEY: "stable-finny-connector-key",
        SECURITY_SCREEN_CLASSIFIER: "proxy",
        SECURITY_SCREEN_PROXY_PROVIDER: "reviewer",
        SECURITY_SCREEN_PROXY_ENDPOINT: "https://screen.example.test/classify",
        SECURITY_SCREEN_PROXY_TOKEN: "screen-token",
      }),
    /FINNY_PROFILE=finny.*SECURITY_SCREEN_CLASSIFIER=model/i,
  );
});
