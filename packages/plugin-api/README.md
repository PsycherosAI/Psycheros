# Psycheros Plugin API

Shared structural types and validation for trusted local plugins. The authoring
guide lives at [`../psycheros/docs/plugins.md`](../psycheros/docs/plugins.md).

I can import `@psycheros/plugin-api/testing` for isolated fixture directories
with sibling `plugins/` and `plugin-secrets/` trees.

From the workspace root, validate a manual installation with:

```powershell
deno task --cwd packages/plugin-api validate <plugin-directory>
```
