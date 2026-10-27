import assert from "node:assert/strict";
import test from "node:test";
import { settingsDom } from "../support/admin-settings.ts";
import { SettingsState, load as loadSettings, states as settingsStates } from "../../src/admin/settings.ts";

const models = {
  baseModelDefault: "a",
  baseModelOptions: [
    { id: "a", name: "Alpha" },
    { id: "b", name: "Beta" },
  ],
  runtime: { modelId: "a", effortLevel: "high", fastMode: true },
  fastModeModelIds: ["a"],
  webuiModels: [],
};

test("model chips add and remove with stable keyed rendering", () => {
  const dom = settingsDom();
  try {
    dom.window.eval("settingsUI.load(" + JSON.stringify(models) + ',"org:test","webui-models")');
    const doc = dom.window.document;
    const input = doc.getElementById("webui-models-add") as HTMLInputElement;
    const options = () => [...doc.querySelectorAll("#webui-models-options option")].map((o) => o.textContent);
    assert.deepEqual(options(), ["Alpha (a)", "Beta (b)"]);
    input.value = "Bet";
    input.dispatchEvent(new dom.window.Event("input"));
    assert.equal((doc.getElementById("webui-models-add-button") as HTMLButtonElement).disabled, true);
    input.value = "b";
    input.dispatchEvent(new dom.window.Event("input"));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter" }));
    assert.deepEqual(options(), ["Alpha (a)"]);
    assert.equal(dom.window.eval('settingsUI.collect("webui-models").ids.join()'), "b");
    dom.window.document.querySelector<HTMLButtonElement>('[aria-label="Remove b"]')!.click();
    assert.equal(dom.window.eval('settingsUI.states.get("webui-models").dirty'), false);
  } finally {
    dom.window.close();
  }
});

test("instructions conflict keeps draft while replacing saved revision and version", () => {
  const dom = settingsDom();
  try {
    dom.window.eval('settingsUI.load({instructions:"old",instructionsVersion:1},"org:test","instructions")');
    dom.window.document.getElementById("instructions-edit")!.click();
    const input = dom.window.document.getElementById("instructions") as HTMLTextAreaElement;
    input.value = "draft <img src=x>";
    input.dispatchEvent(new dom.window.Event("input"));
    dom.window.eval('settingsUI.refreshInstructions({instructions:"other",instructionsVersion:2})');
    assert.equal(input.value, "draft <img src=x>");
    assert.equal(dom.window.document.getElementById("instructions-saved")!.textContent, "other");
    assert.equal(dom.window.eval('settingsUI.collect("instructions").expectedVersion'), 2);
    assert.equal(dom.window.document.querySelector("#card-instructions img"), null);
  } finally {
    dom.window.close();
  }
});

test("default runtime controls save reasoning level and fast mode", () => {
  loadSettings(
    {
      baseModelOptions: [{ id: "a" }],
      baseModelDefault: "a",
      runtime: { modelId: "a", effortLevel: "high", fastMode: true },
      fastModeModelIds: ["a"],
    },
    "org:test",
    "runtime",
  );
  assert.deepEqual(settingsStates.get("runtime")!.collect(), {
    modelId: "a",
    effortLevel: "high",
    fastMode: true,
  });
});

test("instructions saves carry the expected version", () => {
  const state = new SettingsState("instructions");
  state.draft = { content: "test", expectedVersion: 4 };
  assert.equal(state.collect().expectedVersion, 4);
});

test("enabled models add and remove through explicit actions", () => {
  const state = new SettingsState("webui-models");
  state.draft = { ids: [] };
  state.baseline = JSON.stringify(state.draft);
  state.selected = "model-a";
  state.add();
  assert.deepEqual(state.collect(), { ids: ["model-a"] });
  assert.equal(state.dirty, true);
  state.remove("model-a");
  assert.equal(state.dirty, false);
});
