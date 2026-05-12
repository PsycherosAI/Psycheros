# Psycheros docs site

Astro Starlight site for Psycheros documentation. Source markdown lives under
`src/content/docs/`, organized one folder per package.

## Develop

```bash
npm install
npm run dev      # http://localhost:4321
npm run check    # type-check (Astro + MDX + TypeScript)
```

Hot-reload picks up edits to `.md`, `.mdx`, `astro.config.mjs`, and styles.

## Build

```bash
npm run build
npm run preview   # serve dist/ locally to sanity-check the production build
```

`npm run build` also generates the Pagefind search index in `dist/pagefind/`.

## Layout

```
site/
├── astro.config.mjs              # Starlight + Astro config
├── public/
│   └── favicon.svg
├── src/
│   ├── assets/
│   │   └── psycheros-logo.svg
│   ├── components/               # Starlight component overrides
│   │   ├── ThemeProvider.astro   # Forces dark mode
│   │   └── ThemeSelect.astro     # Hides the light/dark toggle
│   ├── content/
│   │   └── docs/
│   │       ├── index.mdx         # Splash landing
│   │       ├── psycheros/        # Mirrors packages/psycheros/docs/
│   │       ├── entity-core/      # Mirrors packages/entity-core/docs/
│   │       └── entity-loom/      # Mirrors packages/entity-loom/docs/
│   └── styles/
│       └── brand.css             # Psycheros tokens mapped to Starlight
└── package.json
```

## Brand notes

- **Dark only.** Matches the Psycheros app's true-black OLED aesthetic. The
  light/dark toggle is hidden via two component overrides in `src/components/`.
  Delete those files and the matching `components` entries in `astro.config.mjs`
  to restore the toggle.
- **Solid violet (`#a855f7`) for UI surfaces, brand gradient reserved for the
  logo + splash H1.** The gradient lives in `--psy-gradient`; reach for it
  sparingly.
- **IBM Plex Sans / Mono** are self-hosted via Fontsource — no third-party
  requests at runtime.

## Migration to public repo

When the public Psycheros repo lands, this directory becomes the docs site that
ships there. Outstanding steps for that migration:

- Set `site` and `base` in `astro.config.mjs` to the public repo URL and path
  (`https://<owner>.github.io` + `/<repo>`).
- Add `.github/workflows/deploy.yml` (Astro's official action +
  `actions/deploy-pages`). The procedure is captured externally — see the
  docs-site handoff doc in the Bridge workspace.
- Repo Settings → Pages → Source: "GitHub Actions" (one-time, manual).
- Decide on a source-of-truth strategy for `src/content/docs/{package}/` vs
  `packages/{package}/docs/` — currently the former are copies of the latter
  with frontmatter added.
