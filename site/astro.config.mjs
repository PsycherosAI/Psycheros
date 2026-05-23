// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// Public GitHub Pages deploy lives at https://psycherosai.github.io/Psycheros/.
// `base` must match the public repo name exactly; Starlight's auto-sidebar
// prepends it, but any hand-written links in frontmatter or hero CTAs must
// use `import.meta.env.BASE_URL` (or a `base`-prefixed path) themselves.

export default defineConfig({
  site: "https://psycherosai.github.io",
  base: "/Psycheros",
  integrations: [
    starlight({
      title: "Psycheros",
      logo: {
        src: "./src/assets/psycheros-logo.svg",
        alt: "Psycheros",
      },
      favicon: "/favicon.svg",
      customCss: ["./src/styles/brand.css"],
      components: {
        // Force dark mode — see each override file for context.
        ThemeProvider: "./src/components/ThemeProvider.astro",
        ThemeSelect: "./src/components/ThemeSelect.astro",
      },
      // Explicit ordering rather than autogenerate so the first entry per
      // section is conceptual (philosophy / overview / user-guide) instead of
      // an alphabetically-first API dump. Top-level Philosophy applies across
      // every package; per-package philosophy files exist on disk for
      // GitHub source readers but aren't surfaced here.
      sidebar: [
        { label: "Philosophy", slug: "philosophy" },
        { label: "Releases", slug: "releases" },
        {
          label: "Launcher",
          items: ["launcher/user-guide"],
        },
        {
          label: "Psycheros",
          items: [
            "psycheros/user-guide",
            "psycheros/configuration",
            "psycheros/ui-features",
            "psycheros/tools-reference",
            "psycheros/memory-and-rag",
            "psycheros/api-reference",
            "psycheros/security-audit",
          ],
        },
        {
          label: "entity-core",
          items: [
            "entity-core/sync-and-memory",
            "entity-core/knowledge-graph",
            "entity-core/mcp-tools",
            "entity-core/snapshots",
            "entity-core/code-review-findings",
            "entity-core/security-audit",
          ],
        },
        {
          label: "entity-loom",
          items: ["entity-loom/user-guide"],
        },
      ],
    }),
  ],
});
