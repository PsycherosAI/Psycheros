# Contributing

Thanks for your interest in contributing to Psycheros.

## Project shape

This is a [Deno 2.x](https://deno.land) workspace containing four packages:

| Package                | Role                                                         |
| ---------------------- | ------------------------------------------------------------ |
| `packages/psycheros`   | The harness daemon (web UI, port 3000)                       |
| `packages/entity-core` | MCP server holding the entity's identity and memory          |
| `packages/entity-loom` | Web wizard for importing chat histories from other platforms |
| `packages/launcher`    | Bootstrap installer and control dashboard                    |

Architecture details live in [`CLAUDE.md`](CLAUDE.md) at the workspace root and
per-package `CLAUDE.md` files. Per-package deep docs live in
`packages/<name>/docs/`.

## Setup

```bash
# Install Deno 2.7.5 or later: https://deno.land/install
git clone <repo-url> && cd <repo>
deno check packages/entity-core/src/mod.ts \
  packages/entity-loom/src/main.ts \
  packages/psycheros/src/main.ts \
  packages/launcher/dashboard.ts
deno lint
deno fmt --check
```

## Conventions

### First-person voice

All prompts, system messages, tool descriptions, comments, and documentation are
written from the entity's first-person perspective ("I am…", "my identity",
never "the assistant"). This is a core design value. Maintain it in every
contribution — including new code comments and any user-facing copy.

If you're not sure how a phrase should read, check the existing files in
`packages/psycheros/src/entity/` or `packages/entity-core/src/tools/` for
examples.

### Style

- **Format check** with `deno fmt --check` before opening a PR. CI gates on it.
- **Lint clean** with `deno lint`. CI also gates on this.
- **Type-check clean** with `deno check` against each package's entry point.
- Add or update tests when fixing bugs in the (very limited) test coverage that
  exists today.

### Module structure

Each `src/*/` directory has a `mod.ts` barrel. Import from `mod.ts`, not
internal files. Add new modules following the same pattern.

### Shared dependencies

Common dependencies (`@std/*`, `@db/sqlite`, `@xenova/transformers`,
`@modelcontextprotocol/sdk`, `jszip`) are hoisted to the workspace root
`deno.json`. Package-specific dependencies stay in each package's own
`deno.json`.

## Pull requests

1. Open an issue first for non-trivial changes — happy to discuss approach
   before you invest the work.
2. Branch from `main`.
3. Keep commits focused. Squash later if needed; we don't enforce a particular
   commit-message style.
4. Make sure CI is green (`check.yml` runs lint / type-check / fmt).
5. Reference any related issue in the PR description.
6. The reviewer may ask for changes — expect that as normal collaboration rather
   than rejection.

## Issues

- **Bug reports**: include the package you're hitting it in, your Deno version,
  and reproduction steps.
- **Feature requests**: explain the use case before proposing the
  implementation. We default to "the smallest change that solves your problem."
- **Security issues**: do not file publicly. Open a private security advisory
  through GitHub's interface instead.

## Code of Conduct

This project follows the
[Contributor Covenant](https://www.contributor-covenant.org/version/2/1/code_of_conduct/)
(see [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md)). Be kind, be precise, be willing
to be wrong.

## License

By contributing, you agree your contributions will be licensed under the
[Mozilla Public License 2.0](LICENSE).
