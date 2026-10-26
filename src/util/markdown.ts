const APP_LINK = /\[([^[\]\n]+)\]\((\/d\/[^\s)[]+)\)/g;

interface FencedCodeBlock {
  start: number;
  end: number;
  body: string;
}

function fenceRun(line: string): string | undefined {
  let indent = 0;
  while (line[indent] === " " || line[indent] === "\t") indent++;
  const mark = line[indent];
  if (mark !== "`" && mark !== "~") return undefined;
  let run = indent;
  while (line[run] === mark) run++;
  if (run - indent < 3 || (mark === "`" && line.includes("`", run))) return undefined;
  return line.slice(indent, run);
}

function fencedCodeBlocks(text: string): FencedCodeBlock[] {
  const blocks: FencedCodeBlock[] = [];
  let open: { start: number; run: string; bodyStart: number } | undefined;
  let offset = 0;
  for (const line of text.split("\n")) {
    const next = offset + line.length + 1;
    const run = fenceRun(line);
    if (!open) {
      if (run) open = { start: offset, run, bodyStart: next };
    } else if (run && run[0] === open.run[0] && run.length >= open.run.length && line.trim() === run) {
      blocks.push({ start: open.start, end: offset + line.length, body: text.slice(open.bodyStart, offset) });
      open = undefined;
    }
    offset = next;
  }
  if (open) {
    blocks.push({ start: open.start, end: text.length, body: text.slice(Math.min(open.bodyStart, text.length)) });
  }
  return blocks;
}

function codeSpans(line: string): Array<[number, number]> {
  const runs: Array<{ start: number; end: number }> = [];
  for (let tick = line.indexOf("`"); tick !== -1; tick = line.indexOf("`", runs.at(-1)!.end)) {
    let end = tick + 1;
    while (line[end] === "`") end++;
    runs.push({ start: tick, end });
  }
  const nextSameLength = Array.from({ length: runs.length }, () => -1);
  const lastByLength = new Map<number, number>();
  for (let i = runs.length - 1; i >= 0; i--) {
    const length = runs[i]!.end - runs[i]!.start;
    nextSameLength[i] = lastByLength.get(length) ?? -1;
    lastByLength.set(length, i);
  }
  const spans: Array<[number, number]> = [];
  for (let i = 0; i < runs.length; i++) {
    const close = nextSameLength[i]!;
    if (close === -1) continue;
    spans.push([runs[i]!.start, runs[close]!.end]);
    i = close;
  }
  return spans;
}

export function codeRegions(text: string): Array<[number, number]> {
  const regions: Array<[number, number]> = [];
  const spansIn = (from: number, to: number) => {
    let at = from;
    for (const line of text.slice(from, to).split("\n")) {
      for (const [start, end] of codeSpans(line)) regions.push([at + start, at + end]);
      at += line.length + 1;
    }
  };
  let cursor = 0;
  for (const block of fencedCodeBlocks(text)) {
    spansIn(cursor, block.start);
    regions.push([block.start, block.end]);
    cursor = block.end;
  }
  spansIn(cursor, text.length);
  return regions;
}

export function absoluteAppLinks(text: string, baseUrl: string | undefined): string {
  if (!baseUrl) return text;
  const regions = codeRegions(text);
  let next = 0;
  return text.replace(APP_LINK, (match: string, label: string, path: string, index: number) => {
    while (next < regions.length && regions[next]![1] <= index) next++;
    const inCode = next < regions.length && regions[next]![0] <= index;
    return inCode ? match : `[${label}](${new URL(path, baseUrl).href})`;
  });
}
