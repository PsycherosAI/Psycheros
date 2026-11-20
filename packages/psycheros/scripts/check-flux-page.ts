/**
 * Rendered-form syntax gate for the Flux page's inline script.
 *
 * The template-literal escape trap (three production strikes now): a regex
 * written with single backslashes in templates.ts renders with the escapes
 * EATEN — the slash-escape and \s collapse, leaving malformed flags — a fatal
 * "Invalid regular expression flags" parse error that kills the WHOLE
 * inline script: badge stuck on LOADING…, timeline dead.
 *
 * Source-form checks pass (the .ts parses fine); only checking the RENDERED
 * string catches it. This script extracts the inline script exactly as the
 * server renders it and node --check's it. Run via `deno task
 * check:flux-page`; wire into CI or pre-restart habit.
 */

import { renderFluxSpacePage } from "../src/server/templates.ts";

const html = renderFluxSpacePage({
  entityName: "the entity",
  userName: "the user",
});

let failed = false;

// The e2e regression loads the rendered page from this fixture (the browser
// image has node but no deno). Refresh it with `deno task check:flux-page
// --write` whenever the page template changes.
const fixtureUrl = new URL("../e2e/fixtures/flux-space.html", import.meta.url);
if (Deno.args.includes("--write")) {
  await Deno.writeTextFile(fixtureUrl, html);
  console.log(`OK: wrote ${fixtureUrl.pathname}`);
} else {
  try {
    const existing = await Deno.readTextFile(fixtureUrl);
    if (existing !== html) {
      console.error(
        "FAIL: e2e/fixtures/flux-space.html is stale; run `deno task check:flux-page --write`",
      );
      failed = true;
    } else {
      console.log("OK: Flux Space fixture matches the rendered page");
    }
  } catch (error) {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
    console.error(
      "FAIL: e2e/fixtures/flux-space.html is missing; run `deno task check:flux-page --write`",
    );
    failed = true;
  }
}

const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((
  m,
) => m[1]);
if (scripts.length === 0) {
  console.error("FAIL: no inline script found in rendered page");
  Deno.exit(1);
}

for (let i = 0; i < scripts.length; i++) {
  const tmp = await Deno.makeTempFile({ suffix: ".js" });
  await Deno.writeTextFile(tmp, scripts[i]);
  const cmd = new Deno.Command("node", {
    args: ["--check", tmp],
    stdout: "null",
    stderr: "piped",
  });
  const { success, stderr } = await cmd.output();
  await Deno.remove(tmp).catch(() => {});
  if (!success) {
    failed = true;
    const err = new TextDecoder().decode(stderr);
    console.error(`FAIL: inline script ${i} has a syntax error:\n${err}`);
  }
}

if (failed) Deno.exit(1);
console.log(
  `OK: ${scripts.length} inline script(s) parse in rendered form`,
);
