import denoJson from "../deno.json" with { type: "json" };

const SUFFIX = Deno.env.get("PSYCHEROS_VERSION_SUFFIX") ?? "";

export const VERSION_BASE: string = denoJson.version;
export const VERSION_SUFFIX: string = SUFFIX;
export const VERSION: string = SUFFIX
  ? `${VERSION_BASE}${SUFFIX}`
  : VERSION_BASE;

export const IS_STAGING: boolean = SUFFIX.startsWith("+staging");
export const IS_PRERELEASE: boolean = SUFFIX !== "";
export const FLAVOR_LABEL: string = SUFFIX.startsWith("+staging")
  ? "staging"
  : SUFFIX.startsWith("+local")
  ? "local"
  : SUFFIX
  ? "build"
  : "";
