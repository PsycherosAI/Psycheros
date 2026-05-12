/**
 * Per-conversation write lock.
 *
 * Serializes database writes to the same conversation across concurrent
 * entity turns.  This prevents race conditions where, for example, an
 * entity turn processing a DM conversation and a send_discord_dm toolcall
 * from another thread both write at the same time, producing invalid
 * role alternation in the message history.
 *
 * Implemented as a promise-chain mutex keyed by conversation ID.
 * Each caller appends to the chain and awaits its predecessor.
 */

const locks = new Map<string, Promise<void>>();

/** Acquire an exclusive lock for a conversation.  Returns a release function. */
export async function acquireLock(
  conversationId: string,
): Promise<() => void> {
  const previous = locks.get(conversationId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((r) => {
    release = r;
  });
  locks.set(conversationId, current);
  await previous;
  return release;
}

/** Convenience wrapper: run a function while holding the lock. */
export async function withConversationLock<T>(
  conversationId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const release = await acquireLock(conversationId);
  try {
    return await fn();
  } finally {
    release();
  }
}
