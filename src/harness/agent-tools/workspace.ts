// The read, write, install_canvas, publish and skill tools: workspace files, apps and skills.

import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { PublishInput } from "../../tools/primitives.ts";
import { errMessage } from "../../util/errors.ts";
import { type ToolKit } from "./kit.ts";
import {
  describePublishAudience,
  optionalBoolean,
  optionalInteger,
  optionalString,
  outsideWorkspace,
  sandboxSelector,
  text,
} from "./shared.ts";

export function workspaceTools(kit: ToolKit) {
  const { discoverSkills, skill } = skillTools(kit);
  const { read, installCanvas, write } = fileTools(kit);
  const { publish } = publishTool(kit);
  return { discoverSkills, skill, read, installCanvas, write, publish };
}

/** The skills list/search and read actions. */
function skillTools(kit: ToolKit) {
  const { ref, recordCall, recordResult } = kit;
  const discoverSkills = (search: boolean) =>
    defineTool({
      name: search ? "search_skills" : "list_skills",
      label: search ? "Search skills" : "List skills",
      description: search
        ? "Search current-scope and organization skills by name or description, including omitted skills. To search a carried source listed in the sharing context, set source. Read a skill before using it."
        : "Browse current-scope and organization skills, including omitted or new skills. Set source to browse a carried source listed in the sharing context. Follow nextOffset within the same source; does not start a sandbox.",
      parameters: Type.Object({
        ...(search
          ? { query: Type.String({ minLength: 1, description: "Words to find in skill names or descriptions." }) }
          : {}),
        source: optionalString(
          "Exact authorized source scope from the sharing context; omitted means current scope and organization.",
        ),
        offset: Type.Optional(Type.Integer({ minimum: 0 })),
        limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 100 })),
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
      "Load a skill by name before relying on it; use list or search for any left out of the per-turn index. Returns its SKILL.md instructions (or the relative file named by `path`) straight from the published source, without starting a sandbox. When the skill ships scripts or supporting files, this call also syncs them into a stable directory on the computer and reports it; run and read them there with execute and files action read. Reading the skill again refreshes that copy.",
    parameters: Type.Object({
      name: Type.String({ description: "Skill name from the skills index, list, or search." }),
      source: optionalString("Use the same source as the discovery call to read that exact skill."),
      path: optionalString("Relative file within the skill to return instead of SKILL.md."),
      sandbox_id: optionalString("Sync the skill's files into this sandbox instead of the default."),
    }),
    async execute(callId, params) {
      const tc = ref.current;
      if (!tc) return text("[error] no active tool context");
      const p = params as { name: string; path?: string; sandbox_id?: string; source?: string };
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

/** The files read, install_canvas and write actions. */
function fileTools(kit: ToolKit) {
  const { ref, recordCall, recordResult, recordText, recordFail } = kit;
  const read = defineTool({
    name: "read",
    label: "read",
    description: "Read a file from the workspace (scope, then global). Returns its contents.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within the workspace." }),
      sandbox_id: sandboxSelector("Sandbox to read from; omit for the default. Shared files ignore it."),
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
      "Replace this person's always-on canvas with a copy of an always-on canvas someone shared with them as a Files record. Always asks them to approve first.",
    parameters: Type.Object({ id: Type.String({ description: "Files ID of the shared canvas." }) }),
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
      "Save file contents in the writable workspace scope. To share it, upload it to Files with POST /v1/files/uploads, then use files action share with the returned ID.",
    parameters: Type.Object({
      path: Type.String({ description: "Relative path within the workspace." }),
      data: Type.String({ description: "File contents, including an empty string to empty the file." }),
      sandbox_id: sandboxSelector("Sandbox to write on; omit for the default."),
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

/** The apps publish action. */
function publishTool(kit: ToolKit) {
  const { ref, recordCall, recordText, recordFail } = kit;
  const publish = defineTool({
    name: "publish",
    label: "publish",
    description:
      "Publish a directory from the workspace as a durable web app " +
      "(it keeps running after the turn ends and gets a stable link). Before publishing, verify the " +
      "directory exists and contains files. For a new app or a code/file update, always pass `entrypoint`; " +
      "the app must listen on the PORT env var. `dir` is workspace-relative: use `app`, never a path " +
      "beginning with `/` or a redundant `workspace/app`. `renameFrom` takes an existing " +
      "deployment name, not its ID. New apps are shared for read/use with their creation channel; DMs stay private. Republishing never changes access; " +
      "grant access separately with apps action share. Share the full absolute URL " +
      "returned by apps action publish so it works in Slack and other surfaces. Use `name` for a friendly, " +
      "stable link /d/<name>/; `renameFrom` to rename; `rollbackTo` to flip back to an earlier version. " +
      "Egress is open, " +
      "so bake data in or have the app fetch it. When the runtime sets $DATA_DIR, state the app " +
      "writes there survives restarts and redeploys; keep durable state there. For a database use " +
      "SQLite at exactly $DATA_DIR/app.db — it gets the strongest durability the runtime offers " +
      "(continuous replication where enabled, periodic snapshots otherwise; a crash can lose the " +
      "most recent writes). The rest of the disk is reset from source on every relaunch. By default " +
      "an app sleeps when idle and cold-starts on the next visit; set `alwaysOn: true` to keep it " +
      "warm (no idle cold starts) — use it only when someone actually needs instant loads, and " +
      "`alwaysOn: false` to turn it back off. An app cannot be shown inside another site's page " +
      "(an iframe) unless `embedAncestors` names that site; set it when someone asks for the app in " +
      "a panel or extension, and `[]` to turn it back off.",
    parameters: Type.Object({
      dir: optionalString(
        "Workspace-relative directory to publish (default: the whole tree). Use `app`, not an absolute path or `workspace/app`.",
      ),
      entrypoint: optionalString(
        'Command the container runs, relative to the app root, e.g. "node server.js". Always provide it for a new app or file update.',
      ),
      name: optionalString("Friendly, globally-unique handle → link is /d/<name>/. Lowercase letters/digits/hyphens."),
      renameFrom: optionalString("Existing deployment name to rename to `name`; this is a name, not an ID."),
      env: Type.Optional(
        Type.Record(Type.String(), Type.String(), {
          description:
            "Env vars baked into the version. When republishing, omit to keep the env of the most recent version (including a failed attempt); pass an object to replace it ({} clears).",
        }),
      ),
      rollbackTo: optionalInteger("Flip the deployment named `name` back to this version number."),
      alwaysOn: optionalBoolean(
        "true keeps the app always warm — it is never put to sleep for being idle, so there are no cold starts. false returns it to the default sleep-when-idle behavior. Omitted = leave the current setting alone.",
      ),
      embedAncestors: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Sites allowed to embed the app in an iframe, as https origins (https://tools.example.com, or https://*.example.com for any subdomain). Every frame between the app and the browser tab must be listed, so a panel inside another site needs both. [] forbids embedding again. Omitted = leave the current setting alone.",
        }),
      ),
      sandbox_id: sandboxSelector("Sandbox holding `dir`; omit for the default. The app's owner is unchanged."),
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
  return { publish };
}
