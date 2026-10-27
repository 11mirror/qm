import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutNeedsSessionList,
  paneNeedsSessionList,
  dropAddsTile,
  MAX_PANES,
  MAX_TILES,
  serializedTileCount,
} from "../src/split-layout.ts";

test("a pane needs the session list only when it remembers a thread but not its session", () => {
  assert.equal(paneNeedsSessionList({ sessionId: "s1", threadRef: "t1" }), false, "named session");
  assert.equal(paneNeedsSessionList({ sessionId: "s1" }), false);
  assert.equal(paneNeedsSessionList({}), false, "a blank pane names nothing and resolves nothing");
  assert.equal(paneNeedsSessionList({ scopeId: "personal:a" } as object), false, "a project's blank pane");
  assert.equal(paneNeedsSessionList({ threadRef: "t1" }), true, "adopted-session pane");
  assert.equal(paneNeedsSessionList({ sessionId: "", threadRef: "t1" }), true, "empty is not an id");
});

test("layoutNeedsSessionList answers for a whole serialized canvas, and distrusts junk", () => {
  const layout = (params: object[]): object => ({
    panels: Object.fromEntries(params.map((p, i) => [`p${i}`, { id: `p${i}`, params: p }])),
  });
  assert.equal(layoutNeedsSessionList(layout([{ sessionId: "s1" }, { sessionId: "s2" }])), false);
  assert.equal(layoutNeedsSessionList(layout([{ sessionId: "s1" }, { threadRef: "t2" }])), true, "one is enough");
  assert.equal(layoutNeedsSessionList(null), true);
  assert.equal(layoutNeedsSessionList({}), true, "no panels map");
  assert.equal(layoutNeedsSessionList({ panels: { p0: {} } }), false, "a panel with no params seeds a blank pane");
});

const leaf = (views: string[]): object => ({ type: "leaf", data: { views, activeView: views[0], id: "g" } });
const branch = (...kids: object[]): object => ({ type: "branch", data: kids });

test("the tile cap counts tiles and turns the overflow into a tab", () => {
  assert.ok(MAX_PANES >= MAX_TILES, "the conversation ceiling must allow every tile to be used");
});

test("a revived canvas is bounded by both caps and cannot blow the stack", () => {
  const tiles = (...kids: object[]): object => ({ grid: { root: branch(...kids) } });
  assert.equal(serializedTileCount(tiles(leaf(["a", "b", "c"]), leaf(["d"]))), 2, "tabs are not tiles");
  assert.equal(serializedTileCount(tiles(branch(leaf(["a"]), leaf(["b"])), branch(leaf(["c"]), leaf(["d"])))), 4);
  assert.equal(
    serializedTileCount(tiles(...Array.from({ length: MAX_TILES }, (_, i) => leaf([String(i)])))),
    MAX_TILES,
  );
  assert.equal(serializedTileCount(null), 0);
  assert.equal(serializedTileCount({ grid: { root: { type: "branch", data: "nonsense" } } }), 0);

  let deep: object = leaf(["a"]);
  for (let i = 0; i < 50_000; i++) deep = branch(deep);
  assert.equal(serializedTileCount({ grid: { root: deep } }), Infinity, "a pathological tree is over the cap");
});

test("only the native drops that would add a tile are refused", () => {
  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 2 }), true, "a tab out of a shared tile");
  assert.equal(dropAddsTile({ edge: false, wholeTile: false, sourceTilePanes: 2 }), false, "joining a tab strip");
  assert.equal(dropAddsTile({ edge: true, wholeTile: true, sourceTilePanes: 1 }), false, "a whole tile only moves");
  assert.equal(
    dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 1 }),
    false,
    "the last pane out of a tile takes that tile with it",
  );
  assert.equal(dropAddsTile({ edge: true, wholeTile: false, sourceTilePanes: 0 }), true, "an unrecognized drag");
});
