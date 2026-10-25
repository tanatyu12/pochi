import { chmod, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

// Resolve everything from the repo root so the script works from any directory.
const root = fileURLToPath(new URL("..", import.meta.url));
const outfile = "dist/pochi.mjs";
const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await build({
  absWorkingDir: root,
  entryPoints: ["src/cli.ts"],
  outfile,
  bundle: true,
  format: "esm",
  platform: "node",
  target: "node22",
  // Shebang lives here only; src/cli.ts must not have one or it would be duplicated.
  // createRequire lets bundled CommonJS dependencies call require() inside ESM.
  banner: {
    js: [
      "#!/usr/bin/env node",
      'import { createRequire as __pochiCreateRequire } from "node:module";',
      "const require = __pochiCreateRequire(import.meta.url);",
    ].join("\n"),
  },
  define: { __POCHI_VERSION__: JSON.stringify(pkg.version) },
  logLevel: "info",
});

await chmod(new URL(`../${outfile}`, import.meta.url), 0o755);
