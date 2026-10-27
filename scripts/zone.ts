import { readFileSync } from "node:fs";
import { lines } from "./wall-of-shame-check.ts";

export const readZone = () => lines(readFileSync("slop-free-zone.txt", "utf8")).filter(Boolean);

export const inZone = (zone: string[], path: string) => zone.some((z) => path === z || path.startsWith(`${z}/`));

export const isReviewable = (path: string) =>
  /\.(ts|tsx|mts|js|mjs|cjs|css|html|sh)$/.test(path) && !/(^|\/)test\/|\.test\./.test(path);
