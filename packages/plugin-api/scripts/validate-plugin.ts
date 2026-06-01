#!/usr/bin/env -S deno run --allow-read

import { resolve } from "@std/path";
import { validatePluginDirectory } from "../src/mod.ts";

const directory = Deno.args[0];
if (!directory) {
  console.error(
    "Usage: deno run --allow-read scripts/validate-plugin.ts <plugin-directory>",
  );
  Deno.exit(1);
}

try {
  const manifest = await validatePluginDirectory(resolve(directory));
  console.log(
    `Validated ${manifest.name} (${manifest.id}) v${manifest.version} for plugin API ${manifest.apiVersion}.`,
  );
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  Deno.exit(1);
}
