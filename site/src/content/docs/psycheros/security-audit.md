---
title: "Security Audit"
---

Status: **Complete** — reviewed for homelab deployment behind Authelia.

## Threat Model

Single-user homelab, Docker container, Authelia reverse proxy. All HTTP
endpoints are auth-gated by Authelia before reaching Psycheros. This context
downgrades many theoretical risks that would be critical in a multi-user or
public deployment.

## Findings Summary

| #   | Issue                                                   | Severity | Status                                        |
| --- | ------------------------------------------------------- | -------- | --------------------------------------------- |
| S1  | Path traversal in entity-core identity tool schemas     | Critical | **FIXED** (in entity-core)                    |
| S2  | XSS in templates.ts hx-confirm attribute                | High     | **FIXED**                                     |
| S3  | XSS in templates.ts background gallery onclick handlers | High     | **FIXED**                                     |
| S4  | Shell tool — no sandboxing                              | High     | **Accepted** — by design                      |
| S5  | SSRF via LLM test endpoint                              | Medium   | **Accepted** — by design                      |
| S6  | Open CORS (`*`) on all endpoints                        | Medium   | **Accepted** — behind Authelia                |
| S7  | No request body size limits (most endpoints)            | Low      | **FIXED**                                     |
| S8  | Error messages leak internal paths                      | Low      | **FIXED**                                     |
| S9  | No auth/IDOR checks on HTTP routes                      | Low      | **Accepted** — Authelia handles auth          |
| S10 | MIME type validation trusts client-provided type        | Low      | **Accepted** — filenames are server-generated |

## Fixed in Psycheros

- **S2 (XSS)**: `src/server/templates.ts:1110` — `categoryLabel` and
  `displayName` now wrapped with `escapeHtml()` in hx-confirm attributes
- **S3 (XSS)**: `src/server/templates.ts:~2411-2416` — added client-side
  `escapeAttr()` helper for all interpolated values in background gallery
  onclick handlers
- **S7 (Body limits)**: Content-Length enforcement: 1MB for JSON/form, 10MB for
  uploads, returns 413
- **S8 (Error leaks)**: 18 catch blocks sanitized — generic messages to clients,
  real errors logged server-side

## Fixed in entity-core

- **S1 (Path traversal)**: `src/tools/identity.ts` — created shared
  `SafeFilenameSchema` with regex `/^[a-zA-Z0-9_-]+\.md$/`, applied to all 5
  identity tool schemas. See
  [entity-core's `docs/code-review-findings.md`](../../entity-core/docs/code-review-findings.md)
  for details.

## Accepted Risks (with rationale)

### S4: Shell tool — no sandboxing

Executes arbitrary commands via `sh -c` with no allowlist, chroot, or path
restrictions. This is an intentional feature — the entity uses it for file
operations, git, etc. Gated by `PSYCHEROS_TOOLS` env var which defaults to `[]`
(no tools enabled). User must explicitly opt in.

### S5: SSRF via LLM test endpoint

Accepts arbitrary `baseUrl` for LLM connection testing. By design — users
configure their own LLM provider URL. Behind Authelia, only the homelab owner
can access this.

### S6: Open CORS

`Access-Control-Allow-Origin: *` on all endpoints. Behind Authelia reverse
proxy, cross-origin requests still need valid auth cookies. Not exploitable in
this deployment model.

### S9: No per-route auth

All endpoints access resources by ID without user-level authorization.
Single-user system behind Authelia — no concept of multiple users.

## Confirmed Safe Patterns

- **SQLite queries** — all parameterized across both repos
- **User/assistant message rendering** — goes through `marked` + `DOMPurify`
  (XSS-safe)
- **Tool arguments and results** — HTML-escaped via `escapeHtml()`
- **Memory tool inputs** — Zod enum for granularity + regex for date
- **API keys** — masked in settings UI via `maskApiKey()`
- **Background file upload** — server-generated filenames, MIME type whitelist,
  5MB size limit
- **Background file delete** — regex `/^[a-zA-Z0-9_.-]+$/` blocks traversal
  after URL decoding
- **Identity file editor** — `isValidFilename()` validates against `../`, `/`,
  `\` before path construction
