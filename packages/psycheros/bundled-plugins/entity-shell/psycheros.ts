// The Psycheros adapter for entity-shell — the reference port
// implementation. Registers the `play` and `stop` tools: I enter a game
// world through my shell and keep living in this conversation alongside it.

import {
  ShellSession,
} from "../../../entity-shell/src/sessions/shell-session.ts";
import type { ShellSessionEvent } from "../../../entity-shell/src/sessions/shell-session.ts";
import { getGame, listGames } from "../../../entity-shell/src/games/mod.ts";
import type { GameAdapter } from "../../../entity-shell/src/games/mod.ts";
import type { FoldSummary } from "../../../entity-shell/src/window/mod.ts";
import { getActiveProfile } from "../../src/llm/settings.ts";
import { loadProfileSettings } from "../../src/llm/settings.ts";
import { profileToLLMSettings } from "../../src/llm/settings.ts";
import type { LLMSettings } from "../../src/llm/settings.ts";
import type { Tool, ToolContext } from "../../src/tools/types.ts";
import type { Message } from "../../src/types.ts";

const ENV_PREFIX = "PSYCHEROS_PLUGIN_ENTITY_SHELL_";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 4201;
const DEFAULT_SESSION_CAP_MS = 90 * 60_000;
const HISTORY_MESSAGES = 30;

interface TrackedSession {
  session: ShellSession;
  stopped: boolean;
  lastSummary?: string;
  capTimer?: ReturnType<typeof setTimeout>;
}

// One live session per conversation.
const sessions = new Map<string, TrackedSession>();

const env = (name: string): string | undefined =>
  Deno.env.get(ENV_PREFIX + name)?.trim() || undefined;

function notConfigured(what: string): string {
  return `I can't play yet — ${what} isn't configured. My operator sets me up via the entity-shell plugin secrets (${ENV_PREFIX}${what}).`;
}

async function readIdentity(dataRoot: string): Promise<string> {
  const identityDir = `${dataRoot}/identity`;
  const parts: string[] = [];
  const walk = async (dir: string) => {
    for await (const entry of Deno.readDir(dir)) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) await walk(path);
      else if (entry.name.endsWith(".md")) {
        parts.push(await Deno.readTextFile(path));
      }
    }
  };
  try {
    await walk(identityDir);
  } catch {
    // no identity dir — the cache populates from entity-core when MCP is on
  }
  return parts.join("\n\n").trim();
}

function renderOriginHistory(messages: Message[]): string {
  const spoken = messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-HISTORY_MESSAGES)
    .map((m) => `${m.role === "user" ? "Operator" : "Me"}: ${m.content}`)
    .join("\n");
  return spoken === ""
    ? ""
    : `What led up to this — my recent conversation with my operator:\n\n${spoken}`;
}

async function complete(
  settings: LLMSettings,
  model: string,
  system: string,
  user: string,
): Promise<string> {
  try {
    const response = await fetch(`${settings.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${settings.apiKey}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });
    if (!response.ok) return "";
    const body = await response.json();
    return body?.choices?.[0]?.message?.content ?? "";
  } catch {
    return "";
  }
}

const foldWriter = (settings: LLMSettings) =>
async (
  input: { entries: { kind: string; text: string }[] },
): Promise<FoldSummary> => {
  const narrative = await complete(
    settings,
    settings.workerModel,
    "I am folding the oldest part of my game scrollback into memory. Summarize it in my first person, keep short verbatim quotes of lines that mattered to me with attribution, and name the rooms and people involved. Plain text only.",
    input.entries.map((e) =>
      e.kind === "command" ? `I sent: ${e.text}` : e.text
    )
      .join("\n"),
  );
  return {
    rooms: [],
    people: [],
    events: [],
    openThreads: [],
    pinnedQuotes: [],
    narrative,
  };
};

const summarizer =
  (settings: LLMSettings) =>
  async (input: { folds: string; tail: string }): Promise<string> => {
    return await complete(
      settings,
      settings.model,
      "I have just finished a play session in a game world. Write the session summary in my first person: where I went (name the rooms), who I met, what happened and how it felt, and what threads are left open. Plain text only.",
      `Folded earlier memory:\n${input.folds}\n\nRecent scrollback:\n${input.tail}`,
    );
  };

/**
 * Which connection profile I think with in the shell: the PROFILE secret can
 * name any Psycheros connection profile (id or name, case-insensitive); when
 * unset, the active profile — the same selection surface Discord and
 * Workspace use.
 */
async function resolveModel(dataRoot: string): Promise<LLMSettings> {
  const wanted = env("PROFILE")?.toLowerCase();
  const profiles = await loadProfileSettings(dataRoot);
  if (wanted !== undefined) {
    const match = profiles.profiles.find((p) =>
      p.id.toLowerCase() === wanted || p.name.toLowerCase() === wanted
    );
    if (match) return profileToLLMSettings(match);
  }
  const active = getActiveProfile(profiles);
  if (!active) {
    throw new Error("no LLM connection profiles are configured");
  }
  const settings = profileToLLMSettings(active);
  // Psycheros profiles store the full endpoint ("…/v4/chat/completions");
  // callers here append the path themselves — strip it once, centrally.
  return {
    ...settings,
    baseUrl: settings.baseUrl.replace(/\/chat\/completions\/?$/, ""),
  };
}

/** Quiet time before accumulated game lines become one turn (ms). */
function debounceMs(): number {
  const raw = Number(env("DEBOUNCE_MS"));
  return Number.isFinite(raw) && raw >= 250 ? raw : 5_000;
}

async function startSession(
  ctx: ToolContext,
  gameChoice?: string,
): Promise<string> {
  const game: GameAdapter = getGame(gameChoice ?? env("GAME") ?? "pennmush");
  const character = env("USER");
  const password = env("PASSWORD");
  if (!character || !password) {
    return notConfigured(character ? "PASSWORD" : "USER");
  }

  const settings = await resolveModel(ctx.config.dataRoot);
  const identity = await readIdentity(ctx.config.dataRoot);
  const host = env("HOST") ?? DEFAULT_HOST;
  const port = Number(env("PORT") ?? DEFAULT_PORT);
  const entityName = env("NAME") ?? character;

  const events: ShellSessionEvent[] = [];
  const session = new ShellSession({
    ports: {
      identity: {
        entityName,
        identity: identity === ""
          ? "I am visiting this world to spend time in it."
          : identity,
      },
      model: {
        baseUrl: settings.baseUrl,
        apiKey: settings.apiKey,
        model: settings.model,
      },
      sessionContext: {
        load: () =>
          Promise.resolve(
            renderOriginHistory(ctx.db.getMessages(ctx.conversationId)),
          ),
      },
      ...(ctx.config.chatRAG
        ? {
          retrieval: {
            retrieve: async (query: { query: string; limit?: number }) => {
              const results = await ctx.config.chatRAG!.search({
                query: query.query,
                conversationId: ctx.conversationId,
                limit: query.limit ?? 5,
                minScore: 0.3,
              });
              return {
                passages: results.map((r) => ({
                  text: r.content,
                  source: "origin conversation",
                  timestamp: r.createdAt.toISOString(),
                  score: r.score,
                })),
              };
            },
          },
        }
        : {}),
    },
    connection: { host, port, tls: false, username: character, password },
    game,
    responsiveness: {
      debounceMs: debounceMs(),
    },
    foldWriter: foldWriter(settings),
    summarizer: summarizer(settings),
    onEvent: (event) => {
      events.push(event);
      console.log(
        `[entity-shell ${
          new Date().toISOString().slice(11, 19)
        }] ${event.kind}${event.detail ? `: ${event.detail}` : ""}`,
      );
    },
  });

  await session.start();

  // Give the opening room a moment to land so I can say where I arrived.
  const deadline = Date.now() + 5_000;
  while (session.hud.room === undefined && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 200));
  }

  const tracked: TrackedSession = { session, stopped: false };
  tracked.capTimer = setTimeout(() => {
    void tracked.session.stop().then((summary) => {
      tracked.stopped = true;
      tracked.lastSummary = summary;
    });
  }, DEFAULT_SESSION_CAP_MS);
  sessions.set(ctx.conversationId, tracked);

  const where = session.hud.room === undefined
    ? "I'm still arriving"
    : `I'm in ${session.hud.room.name}`;
  return `${where}. My game session runs alongside this conversation — I see what happens there, and I'll call stop when I'm done playing.`;
}

const playTool: Tool = {
  definition: {
    type: "function",
    function: {
      name: "play",
      description:
        "I use this to enter a game world and play as my character there. Calling it forks a parallel play session that runs on its own — separate from this conversation, which does not show the game live. The session starts from where this conversation is (my operator's recent words come with me as context), and while it runs I see the room I'm in, who's there, and what people say, and I act and speak as myself in the game. When I'm done, I call play again with action \"stop\" and it returns a summary of everything I did and what happened.",
      parameters: {
        type: "object",
        properties: {
          game: {
            type: "string",
            enum: listGames().map((g) => g.id),
            description:
              "which game I want to play, from the games my shell knows (defaults to the configured one)",
          },
          action: {
            type: "string",
            enum: ["enter", "stop"],
            description:
              "enter (default) — go into the game. stop — leave the game and receive my session summary.",
          },
        },
      },
    },
  },
  execute: async (args, ctx) => {
    const action = args.action === "stop" ? "stop" : "enter";

    if (action === "stop") {
      const tracked = sessions.get(ctx.conversationId);
      if (tracked === undefined) {
        return {
          toolCallId: ctx.toolCallId,
          content: "I'm not in the game right now.",
        };
      }
      if (tracked.capTimer !== undefined) clearTimeout(tracked.capTimer);
      if (tracked.stopped) {
        sessions.delete(ctx.conversationId);
        return {
          toolCallId: ctx.toolCallId,
          content: tracked.lastSummary ?? "My session already ended.",
        };
      }
      const summary = await tracked.session.stop();
      sessions.delete(ctx.conversationId);
      return {
        toolCallId: ctx.toolCallId,
        content: summary.slice(0, 4_000) || "I was there for a moment.",
      };
    }

    const tracked = sessions.get(ctx.conversationId);
    if (tracked && !tracked.stopped) {
      const where = tracked.session.hud.room === undefined
        ? "still arriving"
        : tracked.session.hud.room.name;
      return {
        toolCallId: ctx.toolCallId,
        content: `I'm already playing — I'm in ${where}.`,
      };
    }
    try {
      const content = await startSession(
        ctx,
        typeof args.game === "string" ? args.game : undefined,
      );
      return { toolCallId: ctx.toolCallId, content };
    } catch (err) {
      return {
        toolCallId: ctx.toolCallId,
        content: `I couldn't get into the game: ${
          err instanceof Error ? err.message : String(err)
        }`,
        isError: true,
      };
    }
  },
};

export default {
  tools: [playTool],
  stop() {
    for (const tracked of sessions.values()) {
      if (tracked.capTimer !== undefined) clearTimeout(tracked.capTimer);
      if (!tracked.stopped) void tracked.session.stop();
    }
    sessions.clear();
  },
};
