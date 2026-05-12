// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// `site` and `base` are intentionally unset. They'll be filled in once
// the docs are deployed to GitHub Pages — see README.md for context.

export default defineConfig({
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
      sidebar: [
        {
          label: "Psycheros",
          items: [{ autogenerate: { directory: "psycheros" } }],
        },
        {
          label: "entity-core",
          items: [{ autogenerate: { directory: "entity-core" } }],
        },
        {
          label: "entity-loom",
          items: [{ autogenerate: { directory: "entity-loom" } }],
        },
      ],
    }),
  ],
});
