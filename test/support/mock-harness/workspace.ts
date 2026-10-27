import { type MockScenario, splitWord, startsWith, tool, toolResult } from "./shared.ts";

const ATTACH_TAGS = ["!writeattach ", "!attachsilent ", "!attach "];

export const WORKSPACE_SCENARIOS: MockScenario[] = [
  tool("read", startsWith("!read "), async (t) => {
    const path = t.command0.slice(6).trim();
    const { content } = await t.turn.tools.read(path);
    await toolResult(t, "read", { path, found: content != null });
    return content ?? `(no file: ${path})`;
  }),
  tool("memorysearch", startsWith("!memorysearch "), async (t) => {
    const hits = await t.turn.tools.memorySearch(t.command0.slice("!memorysearch ".length).trim());
    return hits?.join("\n") ?? "(memory unavailable)";
  }),
  tool("memoryread", startsWith("!memoryread "), async (t) => {
    const reply =
      (await t.turn.tools.memoryRead(t.command0.slice("!memoryread ".length).trim())) ?? "(memory unavailable)";
    return reply;
  }),
  tool("memoryremember", startsWith("!memoryremember "), async (t) => {
    const added = await t.turn.tools.memoryAdd([t.command0.slice("!memoryremember ".length).trim()]);
    return added === null ? "(memory unavailable)" : `remembered ${added}`;
  }),
  tool("skill-run", startsWith("!skill-run "), async (t) => {
    const rest = t.command0.slice(11).trim();
    const sp = rest.indexOf(" ");
    const name = sp === -1 ? rest : rest.slice(0, sp);
    const r = await t.turn.tools.skill(name);
    if (r.content == null) return `(no skill file: ${name}/SKILL.md)`;
    const command = rest
      .slice(sp + 1)
      .split("{dir}")
      .join(r.dir ?? "");
    const ran = await t.turn.tools.execute(command);
    return (ran.stdout || ran.stderr).trim();
  }),
  tool("skill", startsWith("!skill "), async (t) => {
    const [name, path] = t.command0.slice(7).trim().split(/\s+/);
    const r = await t.turn.tools.skill(name!, path ? { path } : undefined);
    await toolResult(t, "skill", { name, found: r.content != null, ...(r.dir ? { dir: r.dir } : {}) });
    return r.content == null
      ? `(no skill file: ${name}/${path ?? "SKILL.md"})`
      : `${r.dir ? `${r.dir}\n` : ""}${r.content}`;
  }),
  tool("write", startsWith("!write "), async (t) => {
    const [path, data] = splitWord(t.command0.slice(7));
    await t.turn.tools.write(path, data);
    return `wrote ${path}`;
  }),
  tool(
    "attach",
    (t) => ATTACH_TAGS.some((tag) => t.command0.startsWith(tag)),
    async (t) => {
      const { turn } = t;
      const tag = ATTACH_TAGS.find((x) => t.command0.startsWith(x))!;
      const [head, data] = splitWord(t.command0.slice(tag.length));
      const paths = head.split(",").filter(Boolean);
      if (tag !== "!attach ") {
        for (const path of paths)
          await turn.tools.execute(`printf %s ${JSON.stringify(data)} > ${JSON.stringify(path)}`);
      }
      await turn.emit({ kind: "ToolCall", tool: "attach", body: { files: paths } });
      const r = await turn.tools.attach(paths);
      await toolResult(t, "attach", r.ok ? { ok: true, files: r.files } : { ok: false });
      if (tag === "!attachsilent ") t.silent = turn.pollFire === true;
      return r.ok ? "" : `[not attached] ${r.message}`;
    },
  ),
];
