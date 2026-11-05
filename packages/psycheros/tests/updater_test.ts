import {
  assertEquals,
  assertExists,
  assertRejects,
  assertStringIncludes,
} from "@std/assert";
import { join } from "@std/path";
import * as semver from "@std/semver";
import {
  applyPluginUpdate,
  checkPluginUpdate,
  findLatestTag,
  parseGitHubOwnerRepo,
  UpdateCheckError,
} from "../src/plugins/updater.ts";
import { PluginInstaller } from "../src/plugins/installer.ts";

function updateManifest(
  id: string,
  version: string,
  compatibility: string | undefined,
  update: Record<string, string>,
): Record<string, unknown> {
  return {
    id,
    name: id,
    version,
    apiVersion: 1,
    compatibility: compatibility ? { psycheros: compatibility } : undefined,
    update,
    entrypoints: { psycheros: "./psycheros.ts" },
  };
}

function githubFileResponse(value: unknown): Response {
  return Response.json({
    type: "file",
    encoding: "base64",
    content: btoa(JSON.stringify(value)),
  });
}

async function runGit(cwd: string, args: string[]): Promise<void> {
  const result = await new Deno.Command("git", {
    cwd,
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!result.success) {
    throw new Error(new TextDecoder().decode(result.stderr));
  }
}

Deno.test("parseGitHubOwnerRepo accepts the common GitHub URL shapes", () => {
  // Canonical https.
  assertEquals(
    parseGitHubOwnerRepo("https://github.com/owner/repo"),
    { owner: "owner", repo: "repo" },
  );
  // Trailing .git.
  assertEquals(
    parseGitHubOwnerRepo("https://github.com/owner/repo.git"),
    { owner: "owner", repo: "repo" },
  );
  // Trailing slash + cruft.
  assertEquals(
    parseGitHubOwnerRepo("https://github.com/owner/repo/tree/main"),
    { owner: "owner", repo: "repo" },
  );
  // SSH form.
  assertEquals(
    parseGitHubOwnerRepo("git@github.com:owner/repo.git"),
    { owner: "owner", repo: "repo" },
  );
});

Deno.test("parseGitHubOwnerRepo rejects non-GitHub URLs", () => {
  assertEquals(
    parseGitHubOwnerRepo("https://gitlab.com/owner/repo"),
    undefined,
  );
  assertEquals(
    parseGitHubOwnerRepo("https://example.com/owner/repo"),
    undefined,
  );
  assertEquals(parseGitHubOwnerRepo("not a url"), undefined);
});

Deno.test("findLatestTag picks the highest semver tag, no prefix", () => {
  const result = findLatestTag([
    { name: "v1.0.0" },
    { name: "v1.2.0" },
    { name: "v1.10.0" },
    { name: "v1.2.0-rc1" }, // pre-release — should NOT beat stable 1.10.0
  ]);
  assertExists(result);
  assertEquals(result.tag, "v1.10.0");
  assertEquals(semver.format(result.version), "1.10.0");
});

Deno.test("findLatestTag filters by prefix and strips it before parsing", () => {
  const result = findLatestTag(
    [
      { name: "plugin-1.0.0" },
      { name: "plugin-1.2.0" },
      { name: "other-9.9.9" }, // different prefix, must be skipped
      { name: "1.5.0" }, // no prefix, must be skipped
      { name: "plugin-2.0.0" },
    ],
    "plugin-",
  );
  assertExists(result);
  assertEquals(result.tag, "plugin-2.0.0");
});

Deno.test("findLatestTag returns undefined when no tag parses as semver", () => {
  assertEquals(
    findLatestTag([
      { name: "latest" },
      { name: "nightly" },
      { name: "release-candidate" },
    ]),
    undefined,
  );
});

Deno.test("findLatestTag returns undefined for an empty tag set", () => {
  assertEquals(findLatestTag([]), undefined);
});

Deno.test("findLatestTag with prefix returns undefined when no tag matches the prefix", () => {
  assertEquals(
    findLatestTag(
      [{ name: "v1.0.0" }, { name: "v2.0.0" }],
      "plugin-",
    ),
    undefined,
  );
});

Deno.test("findLatestTag handles a mix of valid semver and junk tags", () => {
  const result = findLatestTag([
    { name: "1.0.0" },
    { name: "junk" },
    { name: "2.0.0" },
    { name: "also-junk" },
    { name: "1.5.0" },
  ]);
  assertExists(result);
  assertEquals(result.tag, "2.0.0");
});

Deno.test("update check selects the newest compatible package in a monorepo", async () => {
  const pluginRoot = await Deno.makeTempDir({
    prefix: "psycheros-update-check-",
  });
  const pluginId = "community-test";
  const packagePath = "plugins/community-test";
  const update = {
    repoUrl: "https://github.com/example/community-addons",
    tagPrefix: "community-test-v",
    packagePath,
  };
  await Deno.mkdir(join(pluginRoot, pluginId));
  await Deno.writeTextFile(
    join(pluginRoot, pluginId, "plugin.json"),
    JSON.stringify(
      updateManifest(pluginId, "1.0.0", ">=0.10.0 <1.0.0", update),
    ),
  );

  const requested: string[] = [];
  const mockFetch = (async (input: string | URL | Request) => {
    const url = String(input);
    requested.push(url);
    if (url.endsWith("/tags?per_page=100")) {
      return Response.json([
        { name: "community-test-v3.0.0" },
        { name: "community-test-v2.0.0" },
        { name: "community-test-v1.2.0" },
        { name: "community-test-v1.0.0" },
      ]);
    }
    if (url.includes("ref=community-test-v3.0.0")) {
      return githubFileResponse(
        updateManifest(pluginId, "3.0.0", "^0.10.0", {
          ...update,
          repoUrl: "https://github.com/example/hijacked-channel",
        }),
      );
    }
    if (url.includes("ref=community-test-v2.0.0")) {
      return githubFileResponse(
        updateManifest(pluginId, "2.0.0", ">=2.0.0", update),
      );
    }
    if (url.includes("ref=community-test-v1.2.0")) {
      return githubFileResponse(
        updateManifest(pluginId, "1.2.0", "^0.10.0", update),
      );
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;

  const result = await checkPluginUpdate(pluginRoot, pluginId, {
    fetch: mockFetch,
  });
  if ("reason" in result) {
    throw new Error(result.message);
  }
  assertEquals(result.updateAvailable, true);
  assertEquals(result.latestVersion, "1.2.0");
  assertEquals(result.latestPublishedVersion, "3.0.0");
  assertEquals(result.skippedUpdateCount, 2);
  assertEquals(result.skippedUpdates?.[0].version, "3.0.0");
  assertStringIncludes(
    result.skippedUpdates?.[0].reasons[0] ?? "",
    "changes update.repoUrl",
  );
  assertEquals(result.skippedUpdates?.[1].version, "2.0.0");
  assertStringIncludes(
    result.skippedUpdates?.[1].reasons[0] ?? "",
    "declares Psycheros compatibility >=2.0.0",
  );
  assertEquals(result.packagePath, packagePath);
  assertEquals(
    requested.some((url) =>
      url.includes(
        "/contents/plugins/community-test/plugin.json?ref=community-test-v1.2.0",
      )
    ),
    true,
  );
});

Deno.test("update apply rejects incompatible tags then atomically updates a monorepo plugin", async () => {
  const root = await Deno.makeTempDir({ prefix: "psycheros-update-apply-" });
  const repo = join(root, "community-addons");
  const packageDirectory = join(repo, "plugins", "community-test");
  const dataRoot = join(root, "data");
  const installer = new PluginInstaller(dataRoot);
  const pluginId = "community-test";
  const update = {
    repoUrl: repo,
    tagPrefix: "community-test-v",
    packagePath: "plugins/community-test",
  };

  await Deno.mkdir(packageDirectory, { recursive: true });
  await runGit(repo, ["init"]);
  await Deno.writeTextFile(
    join(packageDirectory, "plugin.json"),
    JSON.stringify(updateManifest(pluginId, "1.1.0", ">=0.9.0 <1.0.0", update)),
  );
  await Deno.writeTextFile(
    join(packageDirectory, "psycheros.ts"),
    "export default { version: 'compatible' };",
  );
  await runGit(repo, ["add", "."]);
  await runGit(repo, [
    "-c",
    "user.name=Psycheros Tests",
    "-c",
    "user.email=tests@psycheros.local",
    "commit",
    "-m",
    "compatible",
  ]);
  await runGit(repo, ["tag", "community-test-v1.1.0"]);

  await Deno.writeTextFile(
    join(packageDirectory, "plugin.json"),
    JSON.stringify(updateManifest(pluginId, "2.0.0", ">=2.0.0", update)),
  );
  await Deno.writeTextFile(
    join(packageDirectory, "psycheros.ts"),
    "export default { version: 'incompatible' };",
  );
  await runGit(repo, ["add", "."]);
  await runGit(repo, [
    "-c",
    "user.name=Psycheros Tests",
    "-c",
    "user.email=tests@psycheros.local",
    "commit",
    "-m",
    "incompatible",
  ]);
  await runGit(repo, ["tag", "community-test-v2.0.0"]);

  const installedDirectory = join(installer.pluginRoot, pluginId);
  await Deno.mkdir(installedDirectory, { recursive: true });
  await Deno.writeTextFile(
    join(installedDirectory, "plugin.json"),
    JSON.stringify(updateManifest(pluginId, "1.0.0", ">=0.9.0 <1.0.0", update)),
  );
  await Deno.writeTextFile(
    join(installedDirectory, "psycheros.ts"),
    "export default { version: 'installed' };",
  );

  await assertRejects(
    () =>
      applyPluginUpdate(
        installer,
        pluginId,
        "community-test-v2.0.0",
      ),
    UpdateCheckError,
    "not compatible",
  );
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(join(installedDirectory, "plugin.json")),
    ).version,
    "1.0.0",
  );
  const stagedAfterRejection = [];
  for await (const entry of Deno.readDir(installer.stagingRoot)) {
    stagedAfterRejection.push(entry.name);
  }
  assertEquals(stagedAfterRejection, []);

  const applied = await applyPluginUpdate(
    installer,
    pluginId,
    "community-test-v1.1.0",
  );
  assertExists(applied.backupPath);
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(join(installedDirectory, "plugin.json")),
    ).version,
    "1.1.0",
  );
  assertEquals(
    JSON.parse(
      await Deno.readTextFile(join(applied.backupPath!, "plugin.json")),
    ).version,
    "1.0.0",
  );
});
