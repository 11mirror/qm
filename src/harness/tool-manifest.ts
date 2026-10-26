import { adminOperations } from "../tools/admin.ts";

export const CRON_ACTIONS = [
  "create",
  "list",
  "get",
  "runs",
  "patch",
  "delete",
  "run",
  "disable",
  "retarget",
  "note",
] as const;

const READ_ONLY_TOOLS = new Set(["memory", "history", "finish_silently", "runtime", "sessions", "subagents"]);

export interface ToolManifestInput {
  controlTools: boolean;
  surfaceTools: boolean;
  surfaceName?: string;
  delegateWork: boolean;
  sessionTools: boolean;
  readOnly: boolean;
  canvasInstall: boolean;
  adminOperations: boolean;
  connectorTools: ReadonlyArray<{ name: string; serverId: string; readOnly: boolean }>;
  clientTools: readonly string[];
}

export interface ToolManifestEntry {
  name: string;
  source: "native" | "connector" | "client";
  present: boolean;
  reason: string;
  actions?: string[];
  connector?: string;
}

const ALWAYS = "Always available.";
const CONTROL_ON = "The control API is configured.";
const CONTROL_OFF = "The control API is not configured.";
const DELEGATED = "This conversation delegates command work to subagents.";
const NO_SUBAGENTS = "Subagents are not enabled here.";
const READ_ONLY = "Read-only turn.";
export const CONNECTOR_SHADOWED = "A built-in tool has the same name.";

function gate(on: boolean, yes: string, no: string): { present: boolean; reason: string } {
  return { present: on, reason: on ? yes : no };
}

export function toolManifest(input: ToolManifestInput): ToolManifestEntry[] {
  const surface = input.surfaceName ?? "slack";
  const control = input.controlTools;
  const shared = (extra: string[]) => (control ? extra : []);
  const native = (
    name: string,
    state: { present: boolean; reason: string },
    actions?: string[],
  ): ToolManifestEntry => ({
    name,
    source: "native",
    ...state,
    ...(actions ? { actions } : {}),
  });
  const always = { present: true, reason: ALWAYS };
  const builtIn = [
    native("execute", gate(!input.delegateWork, ALWAYS, DELEGATED)),
    native("skills", always, ["list", "search", "read", ...shared(["share", "move"])]),
    native("files", always, [
      "read",
      "write",
      ...shared(["share"]),
      ...(input.canvasInstall ? ["install_canvas"] : []),
    ]),
    native("apps", always, ["publish", ...shared(["share", "move"])]),
    native("memory", always),
    native("history", always),
    native("background", gate(!input.delegateWork, ALWAYS, DELEGATED)),
    native("subagents", gate(input.sessionTools, "Subagents are enabled.", NO_SUBAGENTS)),
    native(
      "sessions",
      input.sessionTools
        ? gate(
            surface === "web",
            "Web conversations can open sidebar sessions.",
            "Sidebar sessions exist only on the web.",
          )
        : { present: false, reason: NO_SUBAGENTS },
    ),
    native("sandbox", always),
    native("cron", gate(control, CONTROL_ON, CONTROL_OFF), [...CRON_ACTIONS, "share"]),
    native("webhook", gate(control, CONTROL_ON, CONTROL_OFF)),
    native(
      "admin",
      gate(control, CONTROL_ON, CONTROL_OFF),
      input.adminOperations ? Object.keys(adminOperations) : ["whoami"],
    ),
    native(
      "guidance",
      gate(control || input.surfaceTools, control ? CONTROL_ON : "This turn posts through the surface.", CONTROL_OFF),
    ),
    native(
      surface,
      gate(input.surfaceTools, "This turn posts through the surface.", "Replies are delivered directly."),
    ),
    native(
      "attach",
      gate(!input.surfaceTools, "Replies are delivered directly.", "This turn posts through the surface."),
    ),
    native("finish_silently", always),
    native("goal", always, ["create", "get", "update"]),
    native("runtime", always),
    native("context", always),
  ];
  const client = [...input.clientTools]
    .sort((a, b) => (a < b ? -1 : 1))
    .map((name): ToolManifestEntry => ({
      name,
      source: "client",
      present: true,
      reason: "Declared by the open page.",
    }));
  const taken = new Set([...builtIn, ...client].filter((entry) => entry.present).map((entry) => entry.name));
  const connectors = input.connectorTools.map((tool): ToolManifestEntry => {
    const base = { name: tool.name, source: "connector" as const, connector: tool.serverId };
    if (input.readOnly && !tool.readOnly)
      return { ...base, present: false, reason: "Read-only turn; this tool writes." };
    if (taken.has(tool.name)) return { ...base, present: false, reason: CONNECTOR_SHADOWED };
    return { ...base, present: true, reason: `Served by the ${tool.serverId} connector.` };
  });
  const scoped = [...builtIn, ...client].map((entry) =>
    input.readOnly && entry.present && !READ_ONLY_TOOLS.has(entry.name)
      ? { ...entry, present: false, reason: READ_ONLY }
      : entry,
  );
  return [...scoped, ...connectors];
}
