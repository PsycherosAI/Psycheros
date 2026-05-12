/**
 * Discord Conversation Mapper
 *
 * Maps Discord channels to Psycheros conversations.
 * Each Discord channel gets its own conversation with source metadata.
 */

import type { DBClient } from "../db/client.ts";

export class ConversationMapper {
  private db: DBClient;
  /** Channel ID → conversation ID cache */
  private cache: Map<string, string> = new Map();

  constructor(db: DBClient) {
    this.db = db;
  }

  /**
   * Get or create a Psycheros conversation for a Discord channel.
   */
  async getOrCreateConversation(
    channelId: string,
    serverId: string | null,
    serverName: string | null,
    channelName: string,
    _channelDisplayName: string,
    isDM: boolean,
    senderUsername: string,
  ): Promise<string> {
    // Check cache
    const cached = this.cache.get(channelId);
    if (cached) {
      const conv = this.db.getConversation(cached);
      if (conv) return cached;
      this.cache.delete(channelId);
    }

    // Check DB
    const existing = this.db.getConversationByChannel(channelId);
    if (existing) {
      this.cache.set(channelId, existing.id);
      return existing.id;
    }

    // Create new conversation
    const title = isDM
      ? `DM > ${senderUsername}`
      : `${serverName || serverId} > #${channelName}`;

    const conv = this.db.createConversation(title, {
      sourceType: "discord",
      sourceServerId: serverId ?? undefined,
      sourceServerName: serverName ?? undefined,
      sourceChannelId: channelId,
      sourceChannelName: channelName,
    });

    this.cache.set(channelId, conv.id);
    return conv.id;
  }

  // ===========================================================================
  // DM Whitelist
  // ===========================================================================

  isDmUserAllowed(userId: string): boolean {
    return this.db.isDmUserAllowed(userId);
  }

  addDmWhitelistEntry(userId: string, username: string, notes: string): void {
    this.db.addDmWhitelistEntry(userId, username, notes);
  }

  removeDmWhitelistEntry(userId: string): void {
    this.db.removeDmWhitelistEntry(userId);
  }

  updateDmWhitelistEntry(
    userId: string,
    username: string,
    notes: string,
  ): void {
    this.db.updateDmWhitelistEntry(userId, username, notes);
  }

  getDmWhitelist() {
    return this.db.getDmWhitelist();
  }

  /**
   * Clear the conversation cache (e.g., after config changes).
   */
  clearCache(): void {
    this.cache.clear();
  }
}
