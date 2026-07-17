import { assertEquals, assertExists } from "@std/assert";
import * as semver from "@std/semver";
import { findLatestTag, parseGitHubOwnerRepo } from "../src/plugins/updater.ts";

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
