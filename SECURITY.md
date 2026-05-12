# Security Policy

## Reporting a vulnerability

If you discover a security vulnerability in Psycheros or any of its companion
packages (`entity-core`, `entity-loom`, `launcher`), please **do not** open a
public issue or pull request.

Report it through GitHub's private vulnerability reporting:

1. Go to the
   [Security tab](https://github.com/PsycherosAI/Psycheros/security/advisories/new)
   on the public repository.
2. Click **Report a vulnerability**.
3. Include a clear description, reproduction steps, and an impact assessment.

You should receive an initial response within 7 days. We'll work with you
through the advisory to coordinate disclosure and a fix.

## Scope

This policy covers vulnerabilities in:

- The Psycheros harness daemon (`packages/psycheros`)
- The `entity-core` MCP server (`packages/entity-core`)
- The `entity-loom` import wizard (`packages/entity-loom`)
- The launcher / installer (`packages/launcher`)
- Workflows and supply-chain configuration under `.github/`

Out of scope:

- Vulnerabilities in upstream dependencies (please report those to the
  respective project; we'll update if we're affected).
- Issues that require an attacker to already have local file-system or admin
  access on the deployment host.
- Resource-exhaustion DoS through the LLM extraction pipeline — rate-limit and
  quota configuration is the operator's responsibility.

## Prior audits

`packages/entity-core/docs/security-audit.md` documents the most recent audit of
the MCP tool surface and the fixes that landed as a result.
