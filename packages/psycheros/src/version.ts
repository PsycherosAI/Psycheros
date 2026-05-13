import denoJson from "../deno.json" with { type: "json" };

const SUFFIX = Deno.env.get("PSYCHEROS_VERSION_SUFFIX") ?? "";

export const VERSION_BASE: string = denoJson.version;
export const VERSION_SUFFIX: string = SUFFIX;
export const VERSION: string = SUFFIX
  ? `${VERSION_BASE}${SUFFIX}`
  : VERSION_BASE;

// True when the build carries the staging-stream suffix specifically — used
// in JSON payloads where the consumer wants to know "is this Echo's dogfood
// image" vs. "is this any non-release build."
export const IS_STAGING: boolean = SUFFIX.startsWith("+staging");

// True when the build carries any build-metadata suffix at all — staging
// container, local docker build, or anything that isn't a tagged public
// release. UI chips treat this as "render non-interactive" because the
// matching release page may not exist (staging is normally ahead; local
// builds never have a release page).
export const IS_PRERELEASE: boolean = SUFFIX !== "";

// Short label for the chip's flavor pill (`v0.1.2 · staging`). Empty when
// the build is a tagged public release.
export const FLAVOR_LABEL: string = SUFFIX.startsWith("+staging")
  ? "staging"
  : SUFFIX.startsWith("+local")
  ? "local"
  : SUFFIX
  ? "build"
  : "";
