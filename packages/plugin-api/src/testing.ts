/**
 * Helpers for exercising my trusted local plugins in Deno tests.
 */

import { join } from "@std/path";
import type { PluginManifest } from "./mod.ts";

export interface PluginFixture {
  root: string;
  directory: string;
  secretsDirectory: string;
}

export async function createPluginFixture(
  manifest: Omit<PluginManifest, "enabled"> & { enabled?: boolean },
  files: Record<string, string>,
  secrets?: Record<string, string>,
): Promise<PluginFixture> {
  const parent = await Deno.makeTempDir({ prefix: "psycheros-plugin-" });
  const root = join(parent, "plugins");
  const directory = join(root, manifest.id);
  const secretsDirectory = join(parent, "plugin-secrets");
  await Deno.mkdir(directory, { recursive: true });
  await Deno.writeTextFile(
    join(directory, "plugin.json"),
    JSON.stringify(manifest, null, 2),
  );
  for (const [path, content] of Object.entries(files)) {
    const destination = join(directory, ...path.split("/"));
    await Deno.mkdir(join(destination, ".."), { recursive: true });
    await Deno.writeTextFile(destination, content);
  }
  if (secrets && Object.keys(secrets).length > 0) {
    await Deno.mkdir(secretsDirectory, { recursive: true });
    await Deno.writeTextFile(
      join(secretsDirectory, `${manifest.id}.env`),
      Object.entries(secrets).map(([name, value]) => `${name}=${value}`).join(
        "\n",
      ),
    );
  }
  return { root, directory, secretsDirectory };
}
