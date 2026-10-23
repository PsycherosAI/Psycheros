import type { HudState } from "../state/mod.ts";
import { MushRouter } from "../routing/router.ts";
import type { RoutedLine } from "../routing/mod.ts";
import type { MuLine } from "../transport/mod.ts";
import { MushClient } from "../transport/mush.ts";
import type {
  GameAdapter,
  GameConnection,
  GameConnectionOptions,
  GameLineRouter,
  GameToolsContext,
  GameToolSpec,
} from "./types.ts";
import { registerGame } from "./registry.ts";

const PAGE_RE = /^(\S+) pages(?: you)?[:,]/;

function tools(ctx: GameToolsContext): GameToolSpec[] {
  return [
    {
      name: "command",
      label: "Command",
      description:
        "I use this to send any game command, exactly as if I typed it — say, pose, movement, page, WHO, all the building commands (dig, @open, @create, @describe…), etc. Several calls in one go are fine.",
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
        required: ["command"],
      },
      run: (args) => ctx.send(String(args.command)).then(() => "Sent."),
    },
  ];
}

/** The PennMUSH family — telnet transport, look-block routing, MUSH verbs. */
export const pennMushAdapter: GameAdapter = {
  id: "pennmush",
  label: "PennMUSH",
  blurb:
    "This is a PennMUSH server. Everything a character can normally do here is mine to do — I can send any command as if I typed it.",
  connect(
    options: GameConnectionOptions,
  ): Promise<GameConnection> {
    return MushClient.connect({
      host: options.host,
      port: options.port,
      tls: options.tls,
      username: options.username,
      password: options.password,
      onLine: (line) => options.onLine(line),
      onClose: (reason) => options.onClose(reason),
    });
  },
  createRouter(hud: HudState): GameLineRouter {
    const router = new MushRouter(hud);
    return {
      route(line: MuLine): RoutedLine {
        return router.route(line);
      },
      get midBlock(): boolean {
        return router.midBlock;
      },
      settle() {
        router.settle();
      },
    };
  },
  tools,
  isDirectMessage(text: string): boolean {
    return PAGE_RE.test(text);
  },
};

registerGame(pennMushAdapter);
