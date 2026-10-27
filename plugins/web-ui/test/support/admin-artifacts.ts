import { JSDOM } from "jsdom";
import { adminBundle } from "./admin-bundle.ts";

const source = adminBundle("artifacts.ts", "artifacts");
const packsSource = adminBundle("artifacts-skills.ts", "skillUI");
export function artifactsFixture() {
  const dom = new JSDOM('<div id="shellbar"></div><main></main>', {
    runScripts: "outside-only",
    url: "http://localhost/settings/files",
    pretendToBeVisual: true,
  });
  dom.window.eval(source + ";window.artifacts = artifacts;");
  dom.window.eval(packsSource + ";window.skillUI = skillUI;");
  dom.window.HTMLElement.prototype.scrollIntoView = () => {};
  const root = dom.window.document.querySelector("main")!;
  const c: Record<string, any> = {
    scope: "personal:alice",
    orgId: "acme",
    view: "files",
    index: false,
    own: false,
    apiBase: "",
    shortName: (s: string) => s,
    dirLabel: (s: string) => s,
    fmtHistoryTime: () => "Today",
    pageShell: (value: any) => {
      c.shell = value;
    },
    api: async () => ({ ok: true, data: {} }),
    go: () => {},
    reload: () => {},
    invalidate: () => {},
    stateToUrl: (s: any) => "/admin/" + s.view + "?scope=" + s.scope,
    openScopeRow: () => {},
    setCronEditing: () => {},
    scopeRows: () => [],
  };
  return { dom, root, c, ui: (dom.window as any).artifacts, skills: (dom.window as any).skillUI };
}
export const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
