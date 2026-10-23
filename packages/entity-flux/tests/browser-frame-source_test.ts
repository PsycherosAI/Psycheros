import { BrowserFrameSource } from "../src/organs/motion-vision/capture.ts";
import { assertEquals } from "@std/assert";

Deno.test("browser source: latest frame wins, null on timeout", async () => {
  const src = new BrowserFrameSource();
  src.start();
  // Nothing pushed → timeout null
  assertEquals(await src.nextFrame(50), null);
  // Push two quickly — the latest is what the consumer gets
  const a = new Uint8Array([1]);
  const b = new Uint8Array([2]);
  src.push(a);
  src.push(b);
  assertEquals(await src.nextFrame(50), b);
  // Consumed → nothing new until the next push
  assertEquals(await src.nextFrame(50), null);
  // A later push wakes a waiting consumer
  const got = src.nextFrame(1000);
  setTimeout(() => src.push(new Uint8Array([3])), 30);
  assertEquals((await got)?.[0], 3);
  // Stopped source drops pushes
  src.stop();
  src.push(new Uint8Array([4]));
  assertEquals(await src.nextFrame(10), null);
});
