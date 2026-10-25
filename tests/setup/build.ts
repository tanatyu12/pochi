import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

// Build once before the suite so tests/bundle.test.ts always checks the current source.
export default async function setup(): Promise<void> {
  const script = fileURLToPath(new URL("../../scripts/build.mjs", import.meta.url));
  await promisify(execFile)(process.execPath, [script]);
}
