/**
 * Unified backup service for entity data.
 *
 * @module
 */

export {
  archiveIfAvailable,
  BackupService,
  type BackupSnapshot,
  type BackupSurface,
  type BatchManifest,
  getBackupService,
  initBackupService,
} from "./service.ts";
