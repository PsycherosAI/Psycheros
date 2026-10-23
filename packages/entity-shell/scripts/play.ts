// Run a real play session — the shell with a live brain.
//
//   deno run -A scripts/play.ts --user Pilgrim --pass <pw> \
//     [--host 127.0.0.1] [--port 4201] [--minutes 5] [--name "My Name"] \
//     [--identity-file path] [--context-file path]
//
// Brain wiring comes from the environment:
//   SHELL_LLM_BASE_URL   e.g. https://api.z.ai/api/paas/v4 (OpenAI-compatible)
//   SHELL_LLM_API_KEY
//   SHELL_LLM_MODEL      e.g. glm-4.7
//
// Ctrl+C or --minutes ends the session and prints the summary.

import { ShellSession } from "../src/sessions/shell-session.ts";
import type { FoldSummary } from "../src/window/mod.ts";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length - 1; i++) {
  if (Deno.args[i].startsWith("--")) {
    args.set(Deno.args[i].slice(2), Deno.args[i + 1]!);
  }
}

const host = args.get("host") ?? "127.0.0.1";
const port = Number(args.get("port") ?? 4201);
const user = args.get("user");
const password = args.get("pass") ?? Deno.env.get("ENTITY_SHELL_TEST_PASSWORD");
const minutes = Number(args.get("minutes") ?? 5);
const baseUrl = Deno.env.get("SHELL_LLM_BASE_URL");
const apiKey = Deno.env.get("SHELL_LLM_API_KEY");
const model = Deno.env.get("SHELL_LLM_MODEL");

if (!user || !password || !baseUrl || !apiKey || !model) {
  console.error(
    "needs: --user, --pass (or ENTITY_SHELL_TEST_PASSWORD), and " +
      "SHELL_LLM_BASE_URL, SHELL_LLM_API_KEY, SHELL_LLM_MODEL",
  );
  Deno.exit(2);
}

const read = (path: string | undefined): string =>
  path ? Deno.readTextFileSync(path) : "";

const foldWriter = async (
  input: { entries: { kind: string; text: string }[] },
): Promise<FoldSummary> => {
  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        {
          role: "system",
          content:
            "I am folding the oldest part of my game scrollback into memory. Summarize it in my first person, keep short verbatim quotes of lines that mattered to me with attribution, and name the rooms and people involved. Plain text only.",
        },
        {
          role: "user",
          content: input.entries.map((e) =>
            e.kind === "command" ? `I sent: ${e.text}` : e.text
          ).join("\n"),
        },
      ],
    }),
  });
  if (!response.ok) {
    return {
      rooms: [],
      people: [],
      events: [],
      openThreads: [],
      pinnedQuotes: [],
      narrative: "",
    };
  }
  const body = await response.json();
  const text = body?.choices?.[0]?.message?.content ?? "";
  return {
    rooms: [],
    people: [],
    events: [],
    openThreads: [],
    pinnedQuotes: [],
    narrative: text,
  };
};

const session = new ShellSession({
  ports: {
    identity: {
      entityName: args.get("name") ?? user,
      identity: read(args.get("identity-file")) ||
        "I am visiting this world to spend time in it.",
    },
    model: { baseUrl: `${baseUrl.replace(/\/$/, "")}`, apiKey, model },
    sessionContext: {
      load: () => Promise.resolve(read(args.get("context-file"))),
    },
  },
  connection: { host, port, tls: false, username: user, password },
  foldWriter,
  onEvent: (event) => {
    if (event.kind === "turn-started") console.error("-- turn --");
    if (event.kind === "stopped") console.error("-- stopped --");
  },
  onLine: (text) => {
    if (args.get("verbose") === "1") console.log(`  ${text}`);
  },
});

const finish = async () => {
  const summary = await session.stop();
  console.log("\n===== session summary =====\n" + summary);
  Deno.exit(0);
};

Deno.addSignalListener("SIGINT", () => void finish());
setTimeout(() => void finish(), minutes * 60_000);

console.error(
  `-- playing ${host}:${port} as ${user} for ${minutes} minutes (Ctrl+C to end) --`,
);
await session.start();
