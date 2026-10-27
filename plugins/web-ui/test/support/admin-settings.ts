import { JSDOM } from "jsdom";
import { adminShell } from "./admin-fixture.ts";
import { adminBundle } from "./admin-bundle.ts";

const bundle = adminBundle("settings.ts", "settingsUI");

export function settingsDom() {
  const dom = new JSDOM(adminShell(), { runScripts: "outside-only" });
  dom.window.structuredClone = structuredClone;
  dom.window.eval(bundle + "; window.settingsUI=settingsUI; settingsUI.mountCards();");
  return dom;
}
