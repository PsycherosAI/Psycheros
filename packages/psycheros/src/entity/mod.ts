/**
 * Entity Module
 *
 * The entity orchestration system that ties together the LLM client,
 * database, and tools into a cohesive agentic loop.
 *
 * @module
 *
 * @example
 * ```typescript
 * import { EntityTurn } from "./entity/mod.ts";
 * import { createDefaultClient } from "./llm/mod.ts";
 * import { DBClient } from "./db/mod.ts";
 * import { createDefaultRegistry } from "./tools/mod.ts";
 *
 * const llm = createDefaultClient();
 * const db = new DBClient("./.psycheros/psycheros.db");
 * const tools = createDefaultRegistry();
 *
 * const turn = new EntityTurn(llm, db, () => tools, {
 *   projectRoot: "/path/to/project",
 * });
 *
 * const conversation = db.createConversation();
 *
 * for await (const chunk of turn.process(conversation.id, "Hello!")) {
 *   if (chunk.type === "content") {
 *     process.stdout.write(chunk.content);
 *   } else if (chunk.type === "tool_result") {
 *     console.log("Tool result:", chunk.result);
 *   }
 * }
 * ```
 */

export { EntityTurn } from "./loop.ts";
export type { EntityConfig, EntityYield, ProcessOptions } from "./loop.ts";

export { generateAndSetTitle } from "./auto-title.ts";
