---
title: "Security Audit"
---

Status: **Complete** — reviewed for homelab deployment behind Authelia.

## Threat Model

entity-core runs as a subprocess spawned by Psycheros, communicating over stdio
(MCP protocol). It has no HTTP server and no direct network exposure. The
primary attack vector is malicious MCP tool calls — either from a compromised
Psycheros instance or from LLM prompt injection causing the entity to call tools
with crafted arguments.

## Critical Fix: Path Traversal in Identity Tools

**Severity:** Critical **Location:** `src/tools/identity.ts:25-71`

The `filename` field in 5 identity tool schemas accepted any string, allowing
`../../.env.md` to escape the data directory. This was the highest-severity
finding across both repos.

**Fix:** Created shared `SafeFilenameSchema` with regex `/^[a-zA-Z0-9_-]+\.md$/`
— enforces alphanumeric filenames at the Zod schema level. Applied to all 5
schemas (`IdentityWriteSchema`, `IdentityAppendSchema`, `IdentityPrependSchema`,
`IdentityUpdateSectionSchema`, `IdentityDeleteCustomSchema`). Inline handler
checks remain as defense-in-depth.

**Important for future development:** Any new identity tools that accept
filenames MUST use `SafeFilenameSchema`. This is the primary security boundary
in the codebase.

## Confirmed Safe Patterns

- **SQL injection**: All queries in `src/graph/store.ts` use `?` placeholders —
  no string concatenation
- **LIKE clauses**: User input wrapped as parameters, not string interpolation
- **Memory tool inputs**: `granularity` is Zod enum-validated; `date` uses
  strict regex
- **Identity category**: Zod enum restricts to `self|user|relationship|custom`
- **Snapshot operations**: Use safe path construction from validated inputs

## Full System Security Audit

For the complete cross-system security audit covering both Psycheros and
entity-core (10 findings, accepted risks with rationale, confirmed safe
patterns), see the Psycheros security audit documentation.
