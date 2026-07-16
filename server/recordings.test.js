import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { buildWavHeader, Recorder } from "./recordings.js";

test("buildWavHeader for 16k mono 16-bit", () => {
  const header = buildWavHeader(2000);
  assert.equal(header.length, 44);
  assert.equal(header.toString("ascii", 0, 4), "RIFF");
  assert.equal(header.toString("ascii", 8, 12), "WAVE");
  assert.equal(header.toString("ascii", 12, 16), "fmt ");
  assert.equal(header.toString("ascii", 36, 40), "data");
  assert.equal(header.readUInt32LE(4), 36 + 2000);     // RIFF chunk size
  assert.equal(header.readUInt32LE(24), 16000);        // sample rate
  assert.equal(header.readUInt16LE(22), 1);            // channels
  assert.equal(header.readUInt32LE(28), 16000 * 1 * 2); // byte rate
  assert.equal(header.readUInt16LE(32), 2);            // block align
  assert.equal(header.readUInt16LE(34), 16);           // bits/sample
  assert.equal(header.readUInt32LE(40), 2000);         // data chunk size
});

async function tmpDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "sienna-rec-"));
}

test("Recorder lifecycle: start, append, stop writes wav", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 10 });
  rec.start();
  rec.appendPcm(Buffer.alloc(2048, 1));
  rec.appendPcm(Buffer.alloc(2048, 2));
  const result = await rec.stop();
  assert.ok(result);
  assert.equal(result.sizeBytes, 44 + 4096);
  const written = await fs.readFile(result.filepath);
  assert.equal(written.length, 44 + 4096);
  assert.equal(written.toString("ascii", 0, 4), "RIFF");
  await fs.rm(dir, { recursive: true });
});

test("Recorder appendPcm before start is no-op", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 10 });
  rec.appendPcm(Buffer.alloc(100));
  const result = await rec.stop();
  assert.equal(result, null);
  await fs.rm(dir, { recursive: true });
});

test("Recorder stop with empty buffer returns null", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 10 });
  rec.start();
  const result = await rec.stop();
  assert.equal(result, null);
  await fs.rm(dir, { recursive: true });
});

test("Recorder list returns saved files newest first", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 10 });
  rec.start();
  rec.appendPcm(Buffer.alloc(200));
  await rec.stop();
  await new Promise(r => setTimeout(r, 10));
  rec.start();
  rec.appendPcm(Buffer.alloc(200));
  const r2 = await rec.stop();
  const list = await rec.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].filename, r2.filename);
  await fs.rm(dir, { recursive: true });
});

test("Recorder delete removes one file; deleting again reports missing", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 20 });
  rec.start();
  rec.appendPcm(Buffer.alloc(100));
  const r = await rec.stop();
  assert.equal((await rec.list()).length, 1);
  assert.equal(await rec.delete(r.filename), true);
  assert.equal((await rec.list()).length, 0);
  assert.equal(await rec.delete(r.filename), false);
});

test("Recorder prunes to keep limit", async () => {
  const dir = await tmpDir();
  const rec = new Recorder({ dir, keep: 2 });
  for (let i = 0; i < 5; i++) {
    rec.start();
    rec.appendPcm(Buffer.alloc(100));
    await rec.stop();
    await new Promise(r => setTimeout(r, 5));
  }
  const list = await rec.list();
  assert.equal(list.length, 2);
  await fs.rm(dir, { recursive: true });
});
