/**
 * Mood-model store tests — on-disk verification logic (no network:
 * the download path is exercised only by refusal guards here).
 */
import { assertEquals } from "@std/assert";
import { join } from "@std/path";
import {
  moodModelBytes,
  moodModelDir,
  moodModelOnDisk,
} from "../../psycheros/src/flux/mood-model-store.ts";

Deno.test("mood-model: per-variant directories under the model cache", () => {
  assertEquals(
    moodModelDir("/data", "int8"),
    "/data/.psycheros/model-cache/vad-bert-int8",
  );
  assertEquals(
    moodModelDir("/data", "fp32"),
    "/data/.psycheros/model-cache/vad-bert-fp32",
  );
});

Deno.test("mood-model: on-disk check demands every file, non-trivially", async () => {
  const root = await Deno.makeTempDir();
  // Empty root: neither variant present.
  assertEquals(await moodModelOnDisk(root, "int8"), false);
  assertEquals(await moodModelBytes(root, "int8"), 0);
  // Complete int8 tree: present, bytes counted.
  const dir = moodModelDir(root, "int8");
  await Deno.mkdir(join(dir, "onnx"), { recursive: true });
  for (
    const [p, bytes] of [
      ["config.json", 500],
      ["tokenizer.json", 20_000],
      ["tokenizer_config.json", 300],
      ["special_tokens_map.json", 100],
      ["vocab.txt", 200_000],
      ["onnx/model.onnx", 60_000_000],
    ] as const
  ) {
    await Deno.writeFile(join(dir, p), new Uint8Array(bytes));
  }
  assertEquals(await moodModelOnDisk(root, "int8"), true);
  assertEquals(await moodModelBytes(root, "int8"), 60_220_900);
  // A truncated model file (the partial-download case) fails the check.
  await Deno.writeFile(
    join(dir, "onnx/model.onnx"),
    new Uint8Array(1_000),
  );
  assertEquals(await moodModelOnDisk(root, "int8"), false);
  await Deno.remove(root, { recursive: true });
});
