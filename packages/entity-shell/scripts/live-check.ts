// Live-fire probe for MushClient against a real MU* server.
//
//   deno run -A scripts/live-check.ts --user Pilgrim --pass <pw> \
//     [--host 127.0.0.1] [--port 4201] [--seconds 20]
//
// Prints every received line (JSON-quoted so escape bytes are visible),
// notes the login trigger, sends look / WHO / QUIT on a fixed cadence, then
// exits. Credentials come from args only — never committed.

import { MushClient } from "../src/transport/mush.ts";

const args = new Map<string, string>();
for (let i = 0; i < Deno.args.length - 1; i++) {
  if (Deno.args[i].startsWith("--")) {
    args.set(Deno.args[i].slice(2), Deno.args[i + 1]!);
  }
}
const host = args.get("host") ?? "127.0.0.1";
const port = Number(args.get("port") ?? 4201);
const user = args.get("user");
const password = args.get("pass");
const seconds = Number(args.get("seconds") ?? 20);

if (!user || !password) {
  console.error(
    "usage: deno run -A scripts/live-check.ts --user <name> --pass <pw> [--host h] [--port p] [--seconds s]",
  );
  Deno.exit(2);
}

setTimeout(() => {
  console.error("-- hard timeout --");
  Deno.exit(1);
}, seconds * 1000);

const started = Date.now();
let lines = 0;

const client = await MushClient.connect({
  host,
  port,
  tls: false,
  username: user,
  password,
  onLine: (line) => {
    lines++;
    console.log(
      `[+${String(Date.now() - started).padStart(6)}ms] ${
        JSON.stringify(line.text)
      }`,
    );
  },
  onClose: (reason) => {
    console.error(
      `-- closed (${
        reason ? reason.message : "remote hang-up"
      }) after ${lines} lines --`,
    );
    Deno.exit(0);
  },
});
console.error(`-- connected to ${host}:${port}, waiting for login screen --`);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const send = async (cmd: string) => {
  console.error(`--> ${cmd}`);
  await client.send(cmd);
};

await sleep(4000);
if (client.loggedIn) {
  await send("look");
} else {
  console.error("-- login never triggered: no 'connect' usage line seen --");
}
await sleep(4000);
await send("WHO");
await sleep(4000);
await send("QUIT");
await sleep(1500);
client.close();
console.error(`-- done after ${lines} lines --`);
Deno.exit(0);
