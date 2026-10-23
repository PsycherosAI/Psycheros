import { assert, assertEquals } from "@std/assert";
import { MushClient } from "../src/transport/mush.ts";

const encoder = new TextEncoder();

interface MockMush {
  port: number;
  /** Non-login lines the server received from the client. */
  lines: string[];
  /** Raw bytes the server received, telnet negotiations included. */
  raw: number[];
  hangup: () => void;
  closed: Promise<void>;
  listener: Deno.Listener;
}

function startMockMush(
  onLogin: (name: string, password: string) => string[],
  offerCharset = true,
): MockMush {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const lines: string[] = [];
  const raw: number[] = [];
  let serverConn: Deno.Conn | undefined;

  const closed = new Promise<void>((resolve) => {
    void (async () => {
      let conn: Deno.Conn;
      try {
        conn = await listener.accept();
        serverConn = conn;
      } catch {
        resolve();
        return;
      }
      try {
        await conn.write(Uint8Array.from([255, 251, 3])); // IAC WILL SGA
        await conn.write(Uint8Array.from([255, 253, 6])); // IAC DO NAWS
        if (offerCharset) {
          // IAC WILL CHARSET — like PennMUSH at connect.
          await conn.write(Uint8Array.from([255, 251, 42]));
        }
        await conn.write(
          encoder.encode(
            'Welcome to the test game.\n\nUse "connect <name> <password>" to log in.\n',
          ),
        );
        const buf = new Uint8Array(4096);
        const decoder = new TextDecoder();
        let lineBuf: number[] = [];
        let sentList = false;
        // Mini telnet filter so negotiations never leak into lines.
        let tel: "data" | "iac" | "opt" | "sb" | "sbIac" = "data";
        while (true) {
          const n = await conn.read(buf);
          if (n === null) break;
          for (let i = 0; i < n; i++) {
            const byte = buf[i];
            raw.push(byte);
            // Client answered IAC DO CHARSET → offer the charset list once.
            // Checked on raw before the telnet filter consumes the bytes.
            if (
              offerCharset && !sentList && raw.length >= 3 &&
              raw.at(-1) === 42 && raw.at(-2) === 253 && raw.at(-3) === 255
            ) {
              sentList = true;
              await conn.write(
                Uint8Array.from([
                  255,
                  250,
                  42,
                  1,
                  59,
                  ...[..."UTF-8"].map((c) => c.charCodeAt(0)),
                  255,
                  240,
                ]),
              );
            }
            if (tel === "iac") {
              tel = byte === 250 ? "sb" : "opt";
              continue;
            }
            if (tel === "opt") {
              tel = "data";
              continue;
            }
            if (tel === "sb") {
              if (byte === 255) tel = "sbIac";
              continue;
            }
            if (tel === "sbIac") {
              tel = "data";
              continue;
            }
            if (byte === 255) {
              tel = "iac";
              continue;
            }
            if (byte === 10) {
              const line = decoder.decode(Uint8Array.from(lineBuf)).replace(
                /\r$/,
                "",
              );
              lineBuf = [];
              lines.push(line);
              if (line.startsWith("connect ")) {
                const [, name, password] = line.split(" ");
                for (const out of onLogin(name ?? "", password ?? "")) {
                  await conn.write(encoder.encode(`${out}\n`));
                }
              }
            } else {
              lineBuf.push(byte);
            }
          }
        }
      } catch {
        // client hung up mid-write
      }
      try {
        conn.close();
      } catch {
        // already closed
      }
      resolve();
    })();
  });

  return {
    port,
    lines,
    raw,
    hangup: () => serverConn?.close(),
    closed,
    listener,
  };
}

function waitForLine(
  lines: string[],
  match: (line: string) => boolean,
  timeoutMs = 5000,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setInterval(() => {
      const found = lines.find(match);
      if (found !== undefined) {
        clearInterval(timer);
        clearTimeout(giveUp);
        resolve(found);
      }
    }, 10);
    const giveUp = setTimeout(() => {
      clearInterval(timer);
      reject(new Error(`timeout waiting for line; got: ${lines.join(" | ")}`));
    }, timeoutMs);
  });
}

function includesSequence(haystack: number[], needle: number[]): boolean {
  outer:
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) {
      if (haystack[i + j] !== needle[j]) continue outer;
    }
    return true;
  }
  return false;
}

Deno.test("negotiates telnet, logs in, and streams clean lines", async () => {
  let loginSeen: { name: string; password: string } | undefined;
  const game = startMockMush((name, password) => {
    loginSeen = { name, password };
    return [
      "Ari has connected.",
      "[1mRoom Zero[0m(#0RL)",
      "A fountain bubbles here.",
    ];
  });

  const clientLines: string[] = [];
  let remoteClosed!: () => void;
  const remoteClosedP = new Promise<void>((resolve) => {
    remoteClosed = resolve;
  });

  const client = await MushClient.connect({
    host: "127.0.0.1",
    port: game.port,
    tls: false,
    username: "Ari",
    password: "quiet-water",
    onLine: (line) => clientLines.push(line.text),
    onClose: () => remoteClosed(),
  });

  try {
    // ANSI-stripped: the mock sends "ESC[1mRoom Zero ESC[0m(#0RL)".
    const room = await waitForLine(
      clientLines,
      (l) => l === "Room Zero(#0RL)",
    );
    assertEquals(room, "Room Zero(#0RL)");
    assertEquals(loginSeen, { name: "Ari", password: "quiet-water" });
    assert(client.loggedIn);

    // Telnet refused politely: WONT NAWS for the DO, DONT SGA for the WILL.
    assert(
      includesSequence(game.raw, [255, 252, 6]),
      "client should answer DO NAWS with WONT NAWS",
    );
    assert(
      includesSequence(game.raw, [255, 254, 3]),
      "client should answer WILL SGA with DONT SGA",
    );

    // No negotiation bytes or carriage returns leaked into game lines.
    for (const line of clientLines) {
      assert(
        !line.includes("ÿ") && !line.includes("�"),
        `IAC byte leaked into line: ${line}`,
      );
      assert(!line.includes("\r"), `CR leaked into line: ${line}`);
    }

    // Commands round-trip.
    await client.send("look");
    await waitForLine(game.lines, (l) => l === "look");

    // Telnet CHARSET negotiation: the client accepts UTF-8 and then sends
    // typographic characters raw — no more "???" from the server.
    assert(
      includesSequence(game.raw, [255, 253, 42]),
      "client should answer WILL CHARSET with DO CHARSET",
    );
    assert(
      includesSequence(
        game.raw,
        [
          255,
          250,
          42,
          2,
          ...[..."UTF-8"].map((c) => c.charCodeAt(0)),
          255,
          240,
        ],
      ),
      "client should accept UTF-8 from the charset list",
    );
    // Outbound typography transliterates even on UTF-8 connections — the
    // server's internal charset translation is lossier than our substitutes.
    await client.send("say em-dash — right here…");
    await waitForLine(game.lines, (l) => l === "say em-dash -- right here...");

    // Remote hang-up fires onClose exactly once.
    game.hangup();
    await remoteClosedP;
    assert(!client.connected);
  } finally {
    client.close();
    game.listener.close();
    await game.closed;
  }
});

Deno.test("transliterates typography when the server offers no charset", async () => {
  const game = startMockMush(() => [], false);
  const clientLines: string[] = [];
  const client = await MushClient.connect({
    host: "127.0.0.1",
    port: game.port,
    tls: false,
    username: "Ari",
    password: "x",
    onLine: (line) => clientLines.push(line.text),
  });
  try {
    await new Promise((r) => setTimeout(r, 300));
    await client.send("say em-dash — right here…");
    await waitForLine(
      game.lines,
      (l) => l === "say em-dash -- right here...",
    );
    assertEquals(client.utf8, false);
  } finally {
    client.close();
    game.listener.close();
    await game.closed;
  }
});
