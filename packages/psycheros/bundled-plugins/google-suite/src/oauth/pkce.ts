/**
 * PKCE (RFC 7636) verifier + challenge generation.
 *
 * Even though this plugin keeps a client secret (confidential client), PKCE
 * is defense-in-depth: if the redirect_uri is intercepted by a malicious
 * local process, the attacker still can't redeem the authorization code
 * without the verifier. Aligns with OAuth 2.1's "always use PKCE" guidance.
 *
 * - Verifier: 72 random bytes, base64url-encoded → ~96 chars. RFC 7636 §4.1
 *   requires 43-128 chars from [A-Z][a-z][0-9]-._~. Base64url output is a
 *   subset of those chars and well within the length range.
 * - Challenge: base64url(SHA-256(verifier)) without padding. Method "S256".
 */
import { encodeBase64Url } from "@std/encoding/base64url";

export function generateCodeVerifier(): string {
  const bytes = new Uint8Array(72);
  crypto.getRandomValues(bytes);
  return encodeBase64Url(bytes);
}

export async function computeCodeChallenge(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return encodeBase64Url(new Uint8Array(digest));
}
