import { writeFile } from "node:fs/promises";
// Node 22.18 strips the types; pochi-art.ts imports nothing relative, so it loads as is.
import { SITTING } from "../src/util/pochi-art.ts";

// Writes docs/pochi.svg (and fixed-color dark and light copies), Pochi as the terminal draws it, for the README. Run after changing SITTING.
const PIXEL = 16;
const COLOR = "#d7afff"; // 256-color 183, as on the terminal
// The terminal's purple fades into a white page, so a light theme gets a deeper one.
const LIGHT_COLOR = "#9a6fd8";

// Cropped to the pixels drawn.
const left = Math.min(...SITTING.map((r) => r.search(/[^.]/)).filter((i) => i >= 0));
const width = Math.max(...SITTING.map((r) => r.replace(/\.+$/, "").length)) - left;
const height = SITTING.length;
const rects = SITTING.flatMap((row, y) =>
  // One rect per run of pixels, so the file stays small and has no seams between them.
  [...row.matchAll(/[^.]+/g)].map(
    (m) => `<rect x="${(m.index - left) * PIXEL}" y="${y * PIXEL}" width="${m[0].length * PIXEL}" height="${PIXEL}"/>`,
  ),
);
// A style of its own follows the viewer's OS theme; the README's <picture> picks a fixed-color one
// by GitHub's theme instead, which can differ from the OS.
const svg = (style) =>
  [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width * PIXEL}" height="${height * PIXEL}" viewBox="0 0 ${width * PIXEL} ${height * PIXEL}" shape-rendering="crispEdges">`,
    `<title>Pochi</title>`,
    `<style>${style}</style>`,
    `<g>`,
    ...rects,
    `</g>`,
    `</svg>`,
    "",
  ].join("\n");
const write = (name, style) => writeFile(new URL(`../docs/${name}`, import.meta.url), svg(style));
await write("pochi.svg", `g { fill: ${COLOR}; } @media (prefers-color-scheme: light) { g { fill: ${LIGHT_COLOR}; } }`);
await write("pochi-dark.svg", `g { fill: ${COLOR}; }`);
await write("pochi-light.svg", `g { fill: ${LIGHT_COLOR}; }`);
