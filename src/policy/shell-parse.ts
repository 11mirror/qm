import { createRequire } from "node:module";
import { Language, Parser, type Node } from "web-tree-sitter";

const require = createRequire(import.meta.url);
await Parser.init();
const parser = new Parser();
parser.setLanguage(await Language.load(require.resolve("tree-sitter-bash/tree-sitter-bash.wasm")));

const SHELLS = new Set(["bash", "sh", "dash", "zsh", "ksh"]);
const SHELL_VALUE_OPTIONS = ["-O", "-o", "--rcfile", "--init-file"];
const SCRIPT_INTERPRETERS = new Set(["node", "perl", "ruby"]);
const INLINE_CODE_OPTIONS: Record<string, string[]> = {
  python: ["-c"],
  node: ["-e", "--eval", "-p", "--print"],
  perl: ["-e", "-E"],
  ruby: ["-e"],
};
const STDIN_SCRIPTS = new Set(["-", "/dev/stdin", "/dev/fd/0", "/proc/self/fd/0"]);
const WRAPPER_OPTIONS: Record<string, string[]> = {
  sudo: [
    "-u",
    "--user",
    "-g",
    "--group",
    "-h",
    "--host",
    "-p",
    "--prompt",
    "-C",
    "--chdir",
    "-T",
    "--command-timeout",
    "-R",
    "--chroot",
    "-t",
    "--type",
  ],
  exec: ["-a"],
  nice: ["-n", "--adjustment"],
  time: ["-o", "--output", "-f", "--format"],
  nohup: [],
  stdbuf: ["-i", "--input", "-o", "--output", "-e", "--error"],
  coproc: [],
  xargs: [
    "-a",
    "--arg-file",
    "-d",
    "--delimiter",
    "-E",
    "--eof",
    "-I",
    "--replace",
    "-L",
    "--max-lines",
    "-n",
    "--max-args",
    "-P",
    "--max-procs",
    "-s",
    "--max-chars",
  ],
};
const SQL_CLIENT_SPECS: Record<string, { options: string[]; sqlPositionalsAfter?: number }> = {
  psql: { options: ["-c", "--command"] },
  pgcli: { options: ["-c", "--command"] },
  mysql: { options: ["-e", "--execute"] },
  mariadb: { options: ["-e", "--execute"] },
  mycli: { options: ["-e", "--execute"] },
  sqlite3: { options: ["-cmd"], sqlPositionalsAfter: 1 },
  sqlcmd: { options: ["-Q", "-q"] },
  duckdb: { options: ["-c", "-s", "--command"], sqlPositionalsAfter: 1 },
  "clickhouse-client": { options: ["-q", "--query"] },
};

export interface Invocation {
  text: string;
  chain: string[][];
}

interface CodePayload {
  text: string;
  sql: boolean;
}

export interface ParsedCommand {
  invocations: Invocation[];
  pipelines: string[][][];
  code: CodePayload[];
  functions: string[];
  unparsed: string[];
}

interface Collected extends ParsedCommand {
  scripts: string[];
}

export function parseShellCommand(command: string): ParsedCommand {
  const parsed: ParsedCommand = { invocations: [], pipelines: [], code: [], functions: [], unparsed: [] };
  const seen = new Set<string>();
  const pending = [command];
  for (let script = pending.shift(); script !== undefined; script = pending.shift()) {
    if (seen.has(script)) continue;
    seen.add(script);
    const collected = collect(script);
    parsed.invocations.push(...collected.invocations);
    parsed.pipelines.push(...collected.pipelines);
    parsed.code.push(...collected.code);
    parsed.functions.push(...collected.functions);
    parsed.unparsed.push(...collected.unparsed);
    const opaque = [...collected.code.map((payload) => payload.text), ...collected.unparsed];
    pending.push(...collected.scripts, ...opaque.flatMap(quotedLiterals));
  }
  return parsed;
}

function quotedLiterals(code: string): string[] {
  const literals: string[] = [];
  for (let i = 0; i < code.length; i++) {
    const quote = code.charAt(i);
    if (!"\"'`".includes(quote)) continue;
    let literal = "";
    let j = i + 1;
    for (; j < code.length && code.charAt(j) !== quote; j++) {
      if (code.charAt(j) === "\\" && quote !== "'") literal += decodeAnsiC(code.slice(j, j + 2));
      else literal += code.charAt(j);
      if (code.charAt(j) === "\\" && quote !== "'") j++;
    }
    if (j >= code.length) break;
    literals.push(literal, ...quotedLiterals(literal));
    i = j;
  }
  return literals;
}

export function basename(word: string): string {
  return word.split("/").pop() ?? word;
}

function innermost(chain: string[][]): string[] {
  return chain.at(-1) ?? [];
}

function parse(command: string) {
  const tree = parser.parse(command);
  if (!tree) throw new Error("tree-sitter-bash produced no syntax tree");
  return tree;
}

function collect(command: string): Collected {
  const tree = parse(command);
  try {
    const collected = walk(tree.rootNode);
    if (tree.rootNode.hasError) collected.unparsed.push(command);
    return collected;
  } finally {
    tree.delete();
  }
}

function bareWord(value: string): string | undefined {
  return /^[\w@%+=:,./-]*$/.test(value) ? value : undefined;
}

function unescapeDoubleQuoted(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const next = text.charAt(i + 1);
    if (text.charAt(i) !== "\\" || !'$`"\\\n'.includes(next)) out += text.charAt(i);
    else if (next !== "\n") out += text.charAt(++i);
    else i++;
  }
  return out;
}

function unescape(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) out += text.charAt(text.charAt(i) === "\\" ? ++i : i);
  return out;
}

function sourceBetween(node: Node, from: number, to: number): string {
  return node.text.slice(from - node.startIndex, to - node.startIndex).replaceAll("\\\n", "");
}

function substitutions(node: Node): Node[] {
  return node.namedChildren.filter(
    (child): child is Node => child?.type === "command_substitution" || child?.type === "process_substitution",
  );
}

function render(node: Node): string {
  switch (node.type) {
    case "raw_string":
      return bareWord(node.text.slice(1, -1)) ?? "''";
    case "ansi_c_string":
      return bareWord(decodeAnsiC(node.text.slice(2, -1))) ?? "''";
    case "string": {
      const subs = substitutions(node);
      if (subs.length) return subs.map(render).join(" ");
      return bareWord(literal(node)) ?? '""';
    }
    case "word":
      return unescape(node.text);
    case "comment":
      return "";
    case "heredoc_body":
      return substitutions(node).map(render).join(" ");
  }
  let out = "";
  let at = node.startIndex;
  for (const child of node.children) {
    if (!child) continue;
    out += sourceBetween(node, at, child.startIndex) + render(child);
    at = child.endIndex;
  }
  return out + sourceBetween(node, at, node.endIndex);
}

function literal(node: Node): string {
  switch (node.type) {
    case "word":
      return unescape(node.text);
    case "raw_string":
      return node.text.slice(1, -1);
    case "ansi_c_string":
      return decodeAnsiC(node.text.slice(2, -1));
    case "string":
      return node.children
        .slice(1, -1)
        .map((child) => (child?.type === "string_content" ? unescapeDoubleQuoted(child.text) : (child?.text ?? "")))
        .join("");
    case "concatenation":
      return node.children.map((child) => (child ? literal(child) : "")).join("");
  }
  return node.text;
}

function variableName(node: Node): string | undefined {
  const [only, ...rest] = node.namedChildren;
  if (!only || rest.length) return undefined;
  if (node.type === "string") return variableName(only);
  const expansion = node.type === "simple_expansion" || node.type === "expansion";
  return expansion && only.type === "variable_name" ? only.text : undefined;
}

function commandWords(command: Node): Node[][] {
  const name = command.childForFieldName("name");
  if (!name) return [];
  const words: Node[][] = [];
  for (const word of [name.firstNamedChild ?? name, ...command.childrenForFieldName("argument")]) {
    if (!word) continue;
    const group = words.at(-1);
    if (group && sourceBetween(command, group.at(-1)!.endIndex, word.startIndex) === "") group.push(word);
    else words.push([word]);
  }
  return words;
}

function argvOf(command: Node): string[] {
  return commandWords(command).map((group) => group.map(literal).join(""));
}

function invocationOf(command: Node): Invocation {
  const text = commandWords(command)
    .map((group) => group.map(render).join(""))
    .join(" ");
  return { text, chain: wrapperChain(argvOf(command)) };
}

export function skipOptions(args: string[], valueOptions: readonly string[]): number {
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "--") return i + 1;
    if (!arg.startsWith("-") || arg === "-") return i;
    if (valueOptions.includes(arg) && !arg.includes("=")) i++;
  }
  return i;
}

function envSplitPayload(argv: string[]): string | undefined {
  if (basename(argv[0] ?? "") !== "env") return undefined;
  const args = argv.slice(1);
  const split = args.findIndex((arg) => arg.startsWith("-S") || arg.startsWith("--split-string"));
  if (split < 0) return undefined;
  const arg = args[split]!;
  if (arg.includes("=")) return [arg.slice(arg.indexOf("=") + 1), ...args.slice(split + 1)].join(" ");
  if (arg.startsWith("-S") && arg.length > 2) return [arg.slice(2), ...args.slice(split + 1)].join(" ");
  return args.slice(split + 1).join(" ");
}

function wrappedCommand(argv: string[]): string[] | undefined {
  const executable = basename(argv[0] ?? "");
  const args = argv.slice(1);
  if (executable === "env") {
    const split = envSplitPayload(argv);
    if (split !== undefined) return parsedWords(split);
    let next = skipOptions(args, ["-u", "--unset", "-C", "--chdir"]);
    while (next < args.length && /^[A-Za-z_]\w*=/.test(args[next]!)) next++;
    return args.slice(next);
  }
  if (executable === "command" || executable === "builtin") {
    const next = skipOptions(args, []);
    return args.slice(0, next).some((arg) => arg === "-v" || arg === "-V") ? undefined : args.slice(next);
  }
  if (executable === "timeout") return args.slice(skipOptions(args, ["-s", "--signal", "-k", "--kill-after"]) + 1);
  const options = WRAPPER_OPTIONS[executable];
  return options ? args.slice(skipOptions(args, options)) : undefined;
}

export function wrapperChain(argv: string[]): string[][] {
  const chain = [argv];
  const seen = new Set([JSON.stringify(argv)]);
  for (let inner = wrappedCommand(argv); inner?.length; inner = wrappedCommand(inner)) {
    const key = JSON.stringify(inner);
    if (seen.has(key)) break;
    seen.add(key);
    chain.push(inner);
  }
  return chain;
}

function parsedWords(text: string): string[] {
  const tree = parse(text);
  try {
    const command = tree.rootNode.descendantsOfType("command")[0];
    return command ? argvOf(command) : [];
  } finally {
    tree.delete();
  }
}

function shellInvocation(inner: string[]): { script?: string; readsStdin: boolean } | undefined {
  if (!SHELLS.has(basename(inner[0] ?? ""))) return undefined;
  const args = inner.slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === "-s") return { readsStdin: true };
    if (arg === "--") return { readsStdin: args[i + 1] === undefined || STDIN_SCRIPTS.has(args[i + 1]!) };
    if (SHELL_VALUE_OPTIONS.includes(arg)) i++;
    else if (!arg.startsWith("-") || arg === "-") return { readsStdin: STDIN_SCRIPTS.has(arg) };
    else if (!arg.startsWith("--") && arg.includes("c")) return { script: args[i + 1], readsStdin: false };
  }
  return { readsStdin: true };
}

export function isShell(argv: string[]): boolean {
  return SHELLS.has(basename(argv[0] ?? ""));
}

function stdinReader(argv: string[]): "shell" | "sql" | "code" | undefined {
  const inner = innermost(wrapperChain(argv));
  const executable = basename(inner[0] ?? "");
  if (shellInvocation(inner)?.readsStdin) return "shell";
  if (sqlClientSpec(inner)) return "sql";
  if (SCRIPT_INTERPRETERS.has(executable) || executable.startsWith("python")) return "code";
  return undefined;
}

function shellPayloads(chain: string[][]): string[] {
  const inner = innermost(chain);
  const splits = chain.map(envSplitPayload).filter((split) => split !== undefined);
  const executable = basename(inner[0] ?? "");
  if (executable === "eval") return [...splits, ...(inner.length > 1 ? [inner.slice(1).join(" ")] : [])];
  const script = shellInvocation(inner)?.script;
  return [...splits, ...(script === undefined ? [] : [script])];
}

function literalProducerPayload(argv: string[]): string | undefined {
  const inner = innermost(wrapperChain(argv));
  const executable = basename(inner[0] ?? "");
  let args = inner.slice(1);
  if (args[0] === "--") args = args.slice(1);
  if (executable === "echo") {
    let decodeEscapes = false;
    while (/^-[neE]+$/.test(args[0] ?? "")) {
      for (const option of args[0]!.slice(1)) {
        if (option === "e") decodeEscapes = true;
        if (option === "E") decodeEscapes = false;
      }
      args = args.slice(1);
    }
    const payload = args.join(" ");
    return decodeEscapes ? decodeAnsiC(payload) : payload;
  }
  if (executable !== "printf" || args.length === 0) return undefined;
  const [format, ...values] = args;
  let valueIndex = 0;
  const rendered = decodeAnsiC(format!).replace(/%([%sb])/g, (_match, conversion: string) => {
    if (conversion === "%") return "%";
    const value = values[valueIndex++] ?? "";
    return conversion === "b" ? decodeAnsiC(value) : value;
  });
  return [rendered, ...values.slice(valueIndex), args.join(" ")].join("\n");
}

function commandOf(node: Node | null): Node | undefined {
  if (node?.type === "command") return node;
  return node?.type === "redirected_statement" ? commandOf(node.childForFieldName("body")) : undefined;
}

function heredocReceivers(statement: Node, redirect: Node): string[][] {
  const continuation = redirect.namedChildren.filter((child) => child?.type !== "heredoc_body");
  return [
    statement.childForFieldName("body"),
    ...continuation.flatMap((child) => child?.descendantsOfType("command") ?? []),
  ]
    .map(commandOf)
    .filter((command) => command !== undefined)
    .map(argvOf);
}

function pipelineStages(pipeline: Node): string[][] {
  return pipeline.namedChildren.flatMap((stage) => {
    if (!stage) return [];
    const command = commandOf(stage);
    return command ? [argvOf(command)] : stage.descendantsOfType("command").map(argvOf);
  });
}

function walk(root: Node): Collected {
  const collected: Collected = { invocations: [], pipelines: [], code: [], functions: [], unparsed: [], scripts: [] };
  const variables = new Map<string, string>();
  const feed = (text: string, readers: string[][]) => {
    const kinds = readers.map(stdinReader);
    if (kinds.includes("shell")) collected.scripts.push(text);
    else if (kinds.includes("sql")) collected.code.push({ text, sql: true });
    else if (kinds.includes("code")) collected.code.push({ text, sql: false });
  };
  const visit = (node: Node) => {
    if (node.type === "variable_assignment") {
      const value = node.childForFieldName("value");
      const name = node.childForFieldName("name")?.text;
      if (name && value && bareWord(literal(value))) variables.set(name, literal(value));
    }
    if (node.type === "function_definition") {
      const name = node.childForFieldName("name")?.text;
      if (name) collected.functions.push(name);
    }
    if (node.type === "command") {
      const invocation = invocationOf(node);
      const argv = invocation.chain[0]!;
      const inner = innermost(invocation.chain);
      collected.invocations.push(invocation);
      collected.scripts.push(...shellPayloads(invocation.chain));
      collected.code.push(
        ...sqlClientPayloads(inner).map((text) => ({ text, sql: true })),
        ...inlineCodePayloads(inner).map((text) => ({ text, sql: false })),
      );
      const position = argv.length - inner.length;
      const word = commandWords(node)[position];
      const variable = word?.length === 1 ? variableName(word[0]!) : undefined;
      const value = variable === undefined ? undefined : variables.get(variable);
      if (value !== undefined)
        collected.scripts.push([...argv.slice(0, position), value, ...argv.slice(position + 1)].join(" "));
      const herestring = node.namedChildren.find((child) => child?.type === "herestring_redirect")?.lastNamedChild;
      if (herestring) feed(literal(herestring), [argv]);
    }
    for (const redirect of node.type === "redirected_statement" ? node.childrenForFieldName("redirect") : []) {
      const body = redirect?.namedChildren.find((child) => child?.type === "heredoc_body");
      if (body) feed(body.text, heredocReceivers(node, redirect!));
    }
    if (node.type === "pipeline") {
      collected.pipelines.push(pipelineStages(node));
      const stages = node.namedChildren.map(commandOf);
      for (let i = 1; i < stages.length; i++) {
        const [producer, consumer] = [stages[i - 1], stages[i]];
        const payload = producer && consumer ? literalProducerPayload(argvOf(producer)) : undefined;
        if (payload) feed(payload, [argvOf(consumer!)]);
      }
    }
    for (const child of node.children) if (child) visit(child);
  };
  visit(root);
  return collected;
}

function decodeAnsiC(value: string): string {
  const named: Record<string, string> = { a: "\x07", b: "\b", e: "\x1b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  return value.replace(/\\(x[0-9a-fA-F]{1,2}|u[0-9a-fA-F]{4}|U[0-9a-fA-F]{8}|[0-7]{1,3}|.)/g, (_, escape: string) => {
    const kind = escape.charAt(0);
    if ("xuU".includes(kind) && escape.length > 1) return String.fromCodePoint(Number.parseInt(escape.slice(1), 16));
    if ("01234567".includes(kind)) return String.fromCodePoint(Number.parseInt(escape, 8));
    return named[escape] ?? ("\\'\"".includes(escape) ? escape : `\\${escape}`);
  });
}

function inlineCodePayloads(words: string[]): string[] {
  const executable = basename(words[0] ?? "");
  const options = INLINE_CODE_OPTIONS[executable.startsWith("python") ? "python" : executable];
  if (!options) return [];
  const payloads: string[] = [];
  for (let i = 1; i < words.length; i++) {
    const arg = words[i]!;
    const option = options.find((opt) => arg === opt || arg.startsWith(`${opt}=`));
    if (!option) continue;
    if (arg === option) {
      if (words[i + 1] !== undefined) payloads.push(words[++i]!);
    } else payloads.push(arg.slice(option.length + 1));
  }
  return payloads;
}

function sqlClientSpec(words: string[]): { options: string[]; sqlPositionalsAfter?: number } | undefined {
  return SQL_CLIENT_SPECS[basename(words[0] ?? "").toLowerCase()];
}

function sqlClientPayloads(words: string[]): string[] {
  const spec = sqlClientSpec(words);
  if (!spec) return [];
  const args = words.slice(1);
  const payloads: string[] = [];
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    let matched = false;
    for (const opt of spec.options) {
      if (arg === opt) {
        if (args[i + 1] !== undefined) payloads.push(args[++i]!);
        matched = true;
        break;
      }
      if (arg.startsWith(`${opt}=`)) {
        payloads.push(arg.slice(opt.length + 1));
        matched = true;
        break;
      }
      if (opt.length === 2 && !arg.startsWith("--") && arg.startsWith(opt) && arg.length > 2) {
        payloads.push(arg.slice(2));
        matched = true;
        break;
      }
    }
    if (!matched && !arg.startsWith("-")) positionals.push(arg);
  }
  if (spec.sqlPositionalsAfter !== undefined) payloads.push(...positionals.slice(spec.sqlPositionalsAfter));
  return payloads;
}
