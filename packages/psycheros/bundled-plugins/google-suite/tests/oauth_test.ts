import { assert, assertEquals } from "@std/assert";
import {
  computeCodeChallenge,
  generateCodeVerifier,
} from "../src/oauth/pkce.ts";
import {
  buildScopeString,
  grantedServices,
  missingScopes,
  SERVICE_SCOPES,
  type ServiceId,
} from "../src/oauth/scopes.ts";

const OPENID_EMAIL = "https://www.googleapis.com/auth/userinfo.email";

Deno.test("PKCE verifier is URL-safe and within RFC 7636 length range (43-128)", () => {
  for (let i = 0; i < 100; i++) {
    const verifier = generateCodeVerifier();
    assert(
      verifier.length >= 43 && verifier.length <= 128,
      `verifier length ${verifier.length} outside [43, 128]: ${verifier}`,
    );
    assert(
      /^[A-Za-z0-9_-]+$/.test(verifier),
      `verifier contains non-URL-safe chars: ${verifier}`,
    );
  }
});

Deno.test("PKCE challenge matches known SHA-256 vector (RFC 7636 §B.1)", async () => {
  const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
  const expected = "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM";
  const actual = await computeCodeChallenge(verifier);
  assertEquals(actual, expected);
});

Deno.test("PKCE challenge has no padding (= chars)", async () => {
  const verifier = generateCodeVerifier();
  const challenge = await computeCodeChallenge(verifier);
  assert(
    !challenge.includes("="),
    `challenge should not be padded: ${challenge}`,
  );
});

Deno.test("buildScopeString always includes userinfo.email", () => {
  const noServices = buildScopeString([]);
  assert(noServices.includes(OPENID_EMAIL));

  const calendarOnly = buildScopeString(["calendar"]);
  assert(calendarOnly.includes(OPENID_EMAIL));
  assert(calendarOnly.includes(SERVICE_SCOPES["calendar"][0]));
  assert(!calendarOnly.includes(SERVICE_SCOPES["gmail"][0]));

  const all: ServiceId[] = [
    "calendar",
    "gmail",
    "drive",
    "contacts",
    "tasks",
    "fit",
  ];
  const allString = buildScopeString(all);
  for (const id of all) {
    for (const scope of SERVICE_SCOPES[id] ?? []) {
      assert(allString.includes(scope));
    }
  }
});

Deno.test("buildScopeString includes all 4 Fit scopes when fit is enabled", () => {
  const fitScopes = buildScopeString(["fit"]);
  for (const scope of SERVICE_SCOPES["fit"]) {
    assert(fitScopes.includes(scope), `missing Fit scope: ${scope}`);
  }
});

Deno.test("missingScopes identifies scopes that require re-OAuth", () => {
  const enabled: ServiceId[] = ["calendar", "gmail"];
  const granted = [SERVICE_SCOPES["calendar"][0], OPENID_EMAIL];
  const missing = missingScopes(enabled, granted);
  assertEquals(missing, [SERVICE_SCOPES["gmail"][0]]);
});

Deno.test("missingScopes returns empty when all enabled scopes are granted", () => {
  const enabled: ServiceId[] = ["calendar"];
  const granted = SERVICE_SCOPES["calendar"];
  assertEquals(missingScopes(enabled, granted), []);
});

Deno.test("missingScopes returns all 4 Fit scopes when none granted", () => {
  const missing = missingScopes(["fit"], []);
  assertEquals(missing.length, 4);
});

Deno.test("grantedServices inverts missingScopes — counts which services' scopes are present", () => {
  const granted = [
    ...SERVICE_SCOPES["calendar"],
    ...SERVICE_SCOPES["contacts"],
    OPENID_EMAIL,
  ];
  assertEquals(grantedServices(granted), ["calendar", "contacts"]);
});

Deno.test("grantedServices requires ALL scopes for multi-scope services like Fit", () => {
  const partial = [
    SERVICE_SCOPES["fit"][0],
    SERVICE_SCOPES["fit"][1],
    OPENID_EMAIL,
  ];
  assertEquals(grantedServices(partial).includes("fit"), false);

  const full = [...SERVICE_SCOPES["fit"], OPENID_EMAIL];
  assertEquals(grantedServices(full).includes("fit"), true);
});
