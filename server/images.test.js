import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ImageStore, createImageStore } from "./images.js";

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "sienna-img-"));
}

test("save() writes a .jpg and returns metadata", async () => {
  const dir = await tmpDir();
  const store = new ImageStore({ dir });
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
  const { filename, filepath, sizeBytes } = await store.save(bytes, { ts: Date.parse("2026-06-07T12:00:00Z") });

  assert.match(filename, /\.jpg$/);
  assert.equal(sizeBytes, bytes.length);
  const onDisk = await fs.readFile(filepath);
  assert.deepEqual(onDisk, bytes);
});

test("save() creates the dir if missing and names sort chronologically", async () => {
  const dir = path.join(await tmpDir(), "nested", "imgs");
  const store = createImageStore({ dir });
  const a = await store.save(Buffer.from([1]), { ts: Date.parse("2026-06-07T12:00:00Z") });
  const b = await store.save(Buffer.from([2]), { ts: Date.parse("2026-06-07T12:00:01Z") });
  assert.ok(a.filename < b.filename, "earlier capture sorts first");
  const files = await fs.readdir(dir);
  assert.equal(files.length, 2);
});

test("deleteFiles() unlinks names and ignores ENOENT", async () => {
  const dir = await tmpDir();
  const store = new ImageStore({ dir });
  const { filename } = await store.save(Buffer.from([1, 2]));
  await store.deleteFiles([filename, "does-not-exist.jpg"]);
  const files = await fs.readdir(dir);
  assert.equal(files.length, 0);
});
