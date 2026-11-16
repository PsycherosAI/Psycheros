/**
 * Run every accessibility browser spec in sequence.
 *
 * Requires a running server and Playwright Chromium (see README.md). Run it
 * with `deno task test:e2e`, or with `node e2e/run.mjs` where Playwright is
 * installed globally.
 */
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const dir = join(dirname(fileURLToPath(import.meta.url)), "specs");
const specs = (await readdir(dir)).filter((f) => f.endsWith(".e2e.mjs")).sort();
if (specs.length === 0) {
  console.error(`no specs found in ${dir}`);
  process.exitCode = 1;
}
for (const spec of specs) {
  console.log(`\n=== ${spec} ===`);
  await import(new URL(`./specs/${spec}`, import.meta.url));
}
