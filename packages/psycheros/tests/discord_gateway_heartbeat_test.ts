import { assertEquals } from "@std/assert";
import { DiscordGatewayClient } from "../src/discord/gateway.ts";

type GatewayInternals = {
  lastHeartbeatAcked: boolean;
  handlePayload: (
    payload: { op: number; d?: unknown; t?: string; s?: number },
  ) => void;
};

Deno.test("Discord gateway starts a resumed socket with a fresh heartbeat cycle", () => {
  const client = new DiscordGatewayClient("token");
  const internals = client as unknown as GatewayInternals;
  internals.lastHeartbeatAcked = false;

  internals.handlePayload({
    op: 10,
    d: { heartbeat_interval: 60_000 },
  });

  assertEquals(internals.lastHeartbeatAcked, true);
  client.disconnect();
});
