import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const SAMPLE_RATE = 16000;
const BIT_DEPTH = 16;
const CHANNELS = 1;

export function buildWavHeader(pcmByteCount) {
  const header = Buffer.alloc(44);
  const byteRate = SAMPLE_RATE * CHANNELS * (BIT_DEPTH / 8);
  const blockAlign = CHANNELS * (BIT_DEPTH / 8);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcmByteCount, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);            // PCM
  header.writeUInt16LE(CHANNELS, 22);
  header.writeUInt32LE(SAMPLE_RATE, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(BIT_DEPTH, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcmByteCount, 40);
  return header;
}

export class Recorder {
  constructor({ dir, keep }) {
    this.dir = dir;
    this.keep = keep;
    this.chunks = [];
    this.recording = false;
    this.startedAt = 0;
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  start() {
    this.chunks = [];
    this.recording = true;
    this.startedAt = Date.now();
  }

  appendPcm(buf) {
    if (!this.recording) return;
    this.chunks.push(buf);
  }

  isRecording() {
    return this.recording;
  }

  async stop() {
    if (!this.recording) return null;
    this.recording = false;
    const pcm = Buffer.concat(this.chunks);
    this.chunks = [];
    if (pcm.length === 0) return null;

    await this.ensureDir();
    const header = buildWavHeader(pcm.length);
    const stamp = new Date(this.startedAt).toISOString().replace(/[:.]/g, "-");
    const id = `${stamp}-${randomUUID().slice(0, 8)}`;
    const filename = `${id}.wav`;
    const filepath = path.join(this.dir, filename);
    await fs.writeFile(filepath, Buffer.concat([header, pcm]));
    await this.prune();
    const durationMs = Math.round((pcm.length / 2) / SAMPLE_RATE * 1000);
    return { id, filename, filepath, sizeBytes: pcm.length + 44, durationMs };
  }

  async prune() {
    try {
      const files = (await fs.readdir(this.dir))
        .filter((f) => f.endsWith(".wav"))
        .sort();
      const toDelete = files.slice(0, Math.max(0, files.length - this.keep));
      await Promise.all(toDelete.map((f) => fs.unlink(path.join(this.dir, f))));
    } catch (e) {
      if (e.code !== "ENOENT") throw e;
    }
  }

  // Delete one saved WAV by filename (validated at the route layer). Returns
  // true if it existed, false if already gone — both leave the same end state.
  async delete(filename) {
    try {
      await fs.unlink(path.join(this.dir, filename));
      return true;
    } catch (e) {
      if (e.code === "ENOENT") return false;
      throw e;
    }
  }

  async list() {
    try {
      const files = (await fs.readdir(this.dir))
        .filter((f) => f.endsWith(".wav"))
        .sort()
        .reverse();
      const out = [];
      for (const f of files) {
        const stat = await fs.stat(path.join(this.dir, f));
        out.push({ filename: f, sizeBytes: stat.size, mtimeMs: stat.mtimeMs });
      }
      return out;
    } catch (e) {
      if (e.code === "ENOENT") return [];
      throw e;
    }
  }
}
