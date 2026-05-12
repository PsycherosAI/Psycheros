# Snapshot System

Identity file snapshots are automatic backups that protect against accidental
data loss. They capture the state of identity files before changes are applied.

## When Snapshots Are Created

| Trigger                        | Description                                                                                         |
| ------------------------------ | --------------------------------------------------------------------------------------------------- |
| **Automatic (identity/write)** | Before `identity_write` overwrites an existing file — creates a targeted snapshot of just that file |
| **Automatic (sync/push)**      | Before `sync_push` applies identity changes — creates a targeted snapshot per changed file          |
| **Scheduled**                  | During scheduled sync operations                                                                    |
| **Manual**                     | On-demand via the `snapshot_create` MCP tool or through the Psycheros UI                            |

Note: `sync_push` creates targeted per-file snapshots (only the files being
changed), not a full snapshot of all identity files.

## Storage

Snapshots are stored in `data/.snapshots/` organized by identity category:

```
data/.snapshots/
├── self/
├── user/
├── relationship/
└── custom/
```

Each snapshot file includes metadata headers with:

- **Timestamp** — when the snapshot was created
- **Reason** — what triggered the snapshot (write, sync, manual)
- **Source** — which embodiment or action caused the change

Filenames follow the pattern: `filename_YYYY-MM-DDTHH-MM-SS-NNNZ.md`

## Retention

Snapshots are automatically cleaned up after the configured retention period.

| Setting                               | Default | Description                             |
| ------------------------------------- | ------- | --------------------------------------- |
| `ENTITY_CORE_SNAPSHOT_RETENTION_DAYS` | `30`    | Days to retain snapshots before cleanup |

Cleanup runs as a Deno cron job. Significant or manually-flagged snapshots can
be excluded from automatic cleanup.

## Restoring

Snapshots can be restored through two methods:

1. **MCP Tool** — Use `snapshot_restore` to restore identity files from a
   specific snapshot
2. **Psycheros UI** — Navigate to Settings → Core Prompts → Snapshots tab

The restore process:

1. List available snapshots via `snapshot_list` (includes metadata for each)
2. Inspect a specific snapshot via `snapshot_get` to review its contents
3. Restore via `snapshot_restore` which replaces the current identity file with
   the snapshot version

A new snapshot is automatically created before any restore operation, so
restores are always reversible.

## Related Source Files

| File                    | Purpose                                         |
| ----------------------- | ----------------------------------------------- |
| `src/tools/snapshot.ts` | Snapshot MCP tools (create, list, get, restore) |
| `src/snapshot/mod.ts`   | Snapshot storage and management logic           |
| `src/snapshot/types.ts` | Snapshot metadata types                         |
