import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PublishAudienceDescriptor, PublishInput } from "../../tools/primitives.ts";
import { errMessage } from "../../util/errors.ts";
import { type ToolKit } from "./kit.ts";
import { optionalBoolean, optionalInteger, optionalString, outsideWorkspace, sandboxSelector, text } from "./shared.ts";

export function workspaceTools(kit: ToolKit) {
  return { ...skillTools(kit), ...fileTools(kit), publish: publishTool(kit) };
}

function skillTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  const discoverSkills = (search: boolean) =>
    defineTool({
      name: search ? "search_skills" : "list_skills",
      label: search ? "Search skills" : "List skills",
      description: search
        ? "Search current-scope and org skills by name or description, including ones left out of the per-turn index (set source for a carried one); read one before using it."
        : "Browse current-scope and org skills, including ones left out of the per-turn index (set source for a carried one); page with nextOffset.",
      parameters: Type.Object({
        ...(search
          ? { query: Type.String({ minLength: 1, description: "Words to find in skill names or descriptions." }) }
          : {}),
        source: optionalString("A carried source from the sharing context; omit for current scope and org."),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1 })),
      }),
      async execute(callId, params) {
        if (!ref.current) return text("[error] no active tool context");
        const p = params as { query?: string; offset?: number; limit?: number; source?: string };
        const action = search ? "search" : "list";
        await recordCall(callId, { tool: "skills", action, ...p });
        const { sourceScopeId, ...result } = await ref.current.listSkills(p.query, p.offset, p.limit, p.source);
        return recordResult(
          callId,
          { tool: "skills", action, count: result.skills.length },
          text(JSON.stringify(result)),
          false,
          { sourceScopeId },
        );
      },
    });

  const skill = defineTool({
    name: "skill",
    label: "skill",
    description:
      "Load a skill's SKILL.md (or the file at `path`) before relying on it. Any scripts it ships are synced to a reported directory on the computer.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from the skills index, list, or search." }),
      source: optionalString("Source from the list/search call that found it."),
      path: optionalString("Relative file to return instead of SKILL.md."),
      sandbox_id: optionalString("Sandbox to sync into; omit for the default."),
    }),
    async execute(callId, p) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "skills",
        action: "read",
        name: p.name,
        ...(p.path ? { path: p.path } : {}),
        ...(p.source ? { source: p.source } : {}),
      });
      const signal = ref.abortSignal;
      signal?.throwIfAborted();
      const { content, sourceScopeId, dir, packDir } = await tc.skill(p.name, {
        ...(p.path ? { path: p.path } : {}),
        ...(p.source ? { source: p.source } : {}),
        ...(p.sandbox_id !== undefined ? { sandboxId: p.sandbox_id } : {}),
        ...(signal ? { signal } : {}),
      });
      signal?.throwIfAborted();
      const onSandbox = p.sandbox_id
        ? ` on sandbox ${p.sandbox_id}; reach them with execute using that sandbox_id`
        : "";
      const where = dir
        ? `[skill files synced to ${dir}/${packDir ? `; pack files at ${packDir}/` : ""}${onSandbox}]\n\n`
        : "";
      return recordResult(
        callId,
        {
          tool: "skills",
          action: "read",
          name: p.name,
          ...(p.path ? { path: p.path } : {}),
          found: content !== null,
          ...(content !== null ? { bytes: content.length, sourceScopeId } : {}),
          ...(dir ? { dir } : {}),
        },
        text(content === null ? `[no such skill file: ${p.name}/${p.path ?? "SKILL.md"}]` : `${where}${content}`),
        content === null,
        { sourceScopeId },
      );
    },
  });
  return { discoverSkills, skill };
}

function fileTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, recordText, recordFail } = kit;
  const read = defineTool({
    name: "read",
    label: "read",
    description: "Read a workspace or shared file.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path." }),
      sandbox_id: sandboxSelector("Sandbox; omit for the default."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "files",
        action: "read",
        path: params.path,
        ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
      });
      const signal = ref.abortSignal;
      signal?.throwIfAborted();
      const {
        content,
        sourceScopeId,
        shared,
        outsideWorkspace: outside,
      } = await tc.read(params.path, signal, params.sandbox_id);
      signal?.throwIfAborted();
      return recordResult(
        callId,
        {
          tool: "files",
          action: "read",
          path: params.path,
          found: content !== null,
          ...(content !== null ? { bytes: content.length, sourceScopeId } : {}),
        },
        text(content ?? (outside ? outsideWorkspace(params.path) : `[no such file: ${params.path}]`)),
        content === null,
        { sourceScopeId, screenAs: shared ? { provenance: "external", source: "shared file" } : undefined },
      );
    },
  });

  const installCanvas = defineTool({
    name: "install_canvas",
    label: "install_canvas",
    description:
      "Replace this person's always-on canvas with a shared one (a Files record); asks them to approve first.",
    parameters: Type.Object({ id: Type.String({ description: "Files ID of the canvas." }) }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc?.installSharedCanvas) return text("[error] installing a shared canvas isn't available on this turn");
      await recordCall(callId, { tool: "files", action: "install_canvas", id: params.id });
      const error = await tc.installSharedCanvas(params.id);
      return recordResult(
        callId,
        { tool: "files", action: "install_canvas", id: params.id, ...(error ? { error } : {}) },
        text(error ? `[error] ${error}` : "Installed the shared canvas as their always-on canvas."),
        Boolean(error),
      );
    },
  });

  const write = defineTool({
    name: "write",
    label: "write",
    description:
      "Write a workspace file. To share it, upload it with POST /v1/files/uploads, then share the returned ID.",
    parameters: Type.Object({
      path: Type.String({ description: "Workspace-relative path." }),
      data: Type.String({ description: "File contents." }),
      sandbox_id: sandboxSelector("Sandbox; omit for the default."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const sandboxNote = params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {};
      await recordCall(callId, {
        tool: "files",
        action: "write",
        path: params.path,
        bytes: params.data.length,
        ...sandboxNote,
      });
      try {
        await tc.write(params.path, params.data, params.sandbox_id);
        return recordText(
          callId,
          { tool: "files", action: "write", path: params.path, bytes: params.data.length, ...sandboxNote },
          `wrote ${params.path} (${params.data.length} bytes)`,
        );
      } catch (e) {
        const msg = errMessage(e);
        return recordFail(
          callId,
          { tool: "files", action: "write", path: params.path, error: msg },
          `[write failed] ${msg}`,
        );
      }
    },
  });
  return { read, installCanvas, write };
}

function publishTool(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail } = kit;
  return defineTool({
    name: "publish",
    label: "publish",
    description:
      "Publish a workspace directory (verify it exists and has files) as a durable web app with a stable link. It must listen on PORT; pass `entrypoint` for a new app or code update. " +
      "New apps are readable by their creation channel (DMs private); republishing never changes access — use share. Give the user the full absolute URL. " +
      "Egress is open. When the runtime sets $DATA_DIR, only it survives restarts and redeploys; for a database use SQLite at exactly $DATA_DIR/app.db (a crash can lose the latest writes). " +
      "Apps sleep when idle; set `alwaysOn` only when someone needs instant loads. Iframes need `embedAncestors`.",
    parameters: Type.Object({
      dir: optionalString(
        "Workspace-relative directory, e.g. `app` (default: whole tree); never absolute or `workspace/app`.",
      ),
      entrypoint: optionalString('Command run from the app root, e.g. "node server.js".'),
      name: optionalString("Unique handle (lowercase letters/digits/hyphens) → /d/<name>/."),
      renameFrom: optionalString("Existing deployment name to rename to `name`."),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description: "Env vars for the version; omit to keep the previous ones, {} clears.",
        }),
      ),
      rollbackTo: optionalInteger("Version number to flip `name` back to."),
      alwaysOn: optionalBoolean("true: never sleep when idle; false: default. Omit to keep."),
      embedAncestors: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "https origins allowed to iframe the app (https://*.example.com works); list every intermediate frame. [] forbids. Omit to keep.",
        }),
      ),
      sandbox_id: sandboxSelector("Sandbox holding `dir`; omit for the default."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      await recordCall(callId, {
        tool: "apps",
        action: "publish",
        dir: params.dir,
        entrypoint: params.entrypoint,
        name: params.name,
        ...(params.sandbox_id !== undefined ? { sandbox_id: params.sandbox_id } : {}),
      });
      try {
        const { sandbox_id: sandboxId, ...input } = params;
        const r = await tc.publish({ ...(input as PublishInput), ...(sandboxId !== undefined ? { sandboxId } : {}) });
        const reach = describePublishAudience(r.audience);
        const alwaysOnNote = r.alwaysOn ? "\nAlways-on: the app is kept warm — no idle cold starts." : "";
        const embedNote = r.embedAncestors?.length ? `\nEmbeddable by: ${r.embedAncestors.join(", ")}` : "";
        const publicNote = r.public ? "\nAccess: public — anyone with the link can open it without signing in." : "";
        const dataNote = r.dataDir
          ? `\nDurable data: runtime state written under ${r.dataDir} ($DATA_DIR) survives restarts and redeploys — keep SQLite at ${r.dataDir}/app.db (it gets the strongest durability the runtime offers). If this app writes runtime state anywhere else on disk, migrate it there (data deliberately baked into the repo stays where it is).`
          : "";
        return recordText(
          callId,
          {
            tool: "apps",
            action: "publish",
            id: r.id,
            name: r.name,
            version: r.version,
            url: r.url,
            ...(r.audience ? { audience: r.audience } : {}),
            ...(r.dataDir ? { dataDir: r.dataDir } : {}),
          },
          `Published ${r.name ?? r.id} (v${r.version}) → ${r.url}\n${reach}${publicNote}${alwaysOnNote}${embedNote}${dataNote}`,
        );
      } catch (e) {
        const msg = errMessage(e);
        return recordFail(callId, { tool: "apps", action: "publish", error: msg }, `[publish failed] ${msg}`);
      }
    },
  });
}

function describePublishAudience(a: PublishAudienceDescriptor | undefined): string {
  if (!a) return "Owned by you.";
  const note = a.note ? ` (note: ${a.note})` : "";
  if (a.kind === "org") return `Owned by you; reachable by anyone at ${a.orgId ?? "your org"}.${note}`;
  if (a.kind === "members") {
    if (a.memberCount === undefined)
      return `Owned by you; access follows the visibility and membership of its shared scopes.${note}`;
    const n = a.memberCount;
    const who = a.channelRef
      ? `the ${n} ${n === 1 ? "person" : "people"} currently in #${a.channelRef}`
      : `${n} ${n === 1 ? "person" : "people"} you've shared it with`;
    return `Owned by you; reachable by ${who} (from any surface they sign in to).${note}`;
  }
  return `Owned by you; owner-only (only you can reach it — use apps action share to widen).${note}`;
}
