// Replaced by esbuild's define at build time; undefined under tsx and vitest.
declare const __POCHI_VERSION__: string | undefined;

export const VERSION = typeof __POCHI_VERSION__ === "string" ? __POCHI_VERSION__ : "0.0.0-dev";
