/**
 * Entity Loom — Checkpoint Manager
 *
 * Manages checkpoint state for pipeline resume support.
 * Checkpoints are stored as checkpoint.json inside the package directory.
 */

import { join } from "@std/path";
import type { CheckpointState, PlatformType } from "../types.ts";

/** Create an empty checkpoint state */
export function createCheckpoint(
  platform: PlatformType,
  instanceId: string,
  entityName: string,
  userName: string,
  contextNotes: string,
  inputPath: string,
): CheckpointState {
  return {
    version: 1,
    platform,
    instanceId,
    entityName,
    userName,
    contextNotes,
    inputPath,
    startedAt: new Date().toISOString(),
    pass1: { completed: false, conversationHashes: {}, parseErrors: [] },
    pass2: { completed: false, storedIds: [] },
    pass3a: { completed: false, processedDates: [], failedDates: [] },
    pass3b: {
      completed: false,
      processedConversationIds: [],
      failedConversationIds: [],
    },
    pass4: { completed: false, processedMemories: [] },
    pass5: { completed: false },
  };
}

export class CheckpointManager {
  private packageDir: string;

  constructor(packageDir: string) {
    this.packageDir = packageDir;
  }

  /** Get the checkpoint file path */
  private get checkpointPath(): string {
    return join(this.packageDir, "checkpoint.json");
  }

  /** Ensure the package directory exists */
  private async ensureDir(): Promise<void> {
    await Deno.mkdir(this.packageDir, { recursive: true });
  }

  /** Load checkpoint from disk, or return null if none exists */
  async load(): Promise<CheckpointState | null> {
    try {
      const text = await Deno.readTextFile(this.checkpointPath);
      return JSON.parse(text) as CheckpointState;
    } catch (error) {
      if (error instanceof Deno.errors.NotFound) return null;
      throw new Error(
        `Failed to load checkpoint: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }

  /** Save checkpoint to disk */
  async save(state: CheckpointState): Promise<void> {
    await this.ensureDir();
    await Deno.writeTextFile(
      this.checkpointPath,
      JSON.stringify(state, null, 2),
    );
  }

  /** Check if a specific pass is complete */
  isPassComplete(
    state: CheckpointState,
    pass: "pass1" | "pass2" | "pass3a" | "pass3b" | "pass4" | "pass5",
  ): boolean {
    return state[pass].completed;
  }

  /** Check if a specific conversation was already parsed (by hash) */
  wasConversationParsed(state: CheckpointState, hash: string): boolean {
    return Object.values(state.pass1.conversationHashes).includes(hash);
  }

  /** Check if a specific conversation was already stored */
  wasConversationStored(state: CheckpointState, convId: string): boolean {
    return state.pass2.storedIds.includes(convId);
  }

  /** Check if a specific date was already processed for daily memories */
  wasDateProcessed(state: CheckpointState, date: string): boolean {
    return state.pass3a.processedDates.includes(date);
  }

  /** Get list of failed dates for retry */
  getFailedDates(state: CheckpointState): string[] {
    return state.pass3a.failedDates;
  }

  /** Check if a conversation was already processed for significant memories */
  wasConversationProcessedForSig(
    state: CheckpointState,
    convId: string,
  ): boolean {
    return state.pass3b.processedConversationIds.includes(convId);
  }

  /** Check if a memory file was already processed for graph */
  wasMemoryProcessed(state: CheckpointState, memoryPath: string): boolean {
    return state.pass4.processedMemories.includes(memoryPath);
  }
}
