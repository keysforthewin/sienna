import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

// On-disk store for camera JPEGs — the byte sibling of recordings.js. Mongo (the
// `images` collection) is the index / cap source of truth; this just owns file
// IO. save() writes one snapshot and returns its filename; deleteFiles() unlinks
// the names memory.pruneImages() reports as evicted (ENOENT is ignored — a missing
// file just means it was already gone).
export class ImageStore {
  constructor({ dir }) {
    this.dir = dir;
  }

  async ensureDir() {
    await fs.mkdir(this.dir, { recursive: true });
  }

  // Filename mirrors recordings.js: a sortable ISO stamp + a short uuid, so the
  // names sort chronologically and never collide. ts is injected for testability.
  async save(jpegBuffer, { ts = Date.now() } = {}) {
    await this.ensureDir();
    const stamp = new Date(ts).toISOString().replace(/[:.]/g, "-");
    const filename = `${stamp}-${randomUUID().slice(0, 8)}.jpg`;
    const filepath = path.join(this.dir, filename);
    await fs.writeFile(filepath, jpegBuffer);
    return { filename, filepath, sizeBytes: jpegBuffer.length };
  }

  async deleteFiles(filenames) {
    await Promise.all((filenames || []).map(async (f) => {
      try {
        await fs.unlink(path.join(this.dir, f));
      } catch (e) {
        if (e.code !== "ENOENT") throw e;
      }
    }));
  }
}

export function createImageStore(opts) {
  return new ImageStore(opts);
}
