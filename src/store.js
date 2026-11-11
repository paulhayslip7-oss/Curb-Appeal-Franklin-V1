// Tiny key-value storage with two interchangeable backends:
//   - files on disk   (local development, or any host with a persistent disk)
//   - Netlify Blobs   (when deployed on Netlify)
// Keys look like "properties/abc123". Values are JSON, or raw bytes for photos.

import fs from 'node:fs/promises';
import path from 'node:path';

const safeKey = (key) => {
  if (!/^[a-zA-Z0-9_\-/]+$/.test(key) || key.includes('//')) throw new Error(`Bad storage key: ${key}`);
  return key;
};

export function fileStore(dir) {
  const file = (key, ext) => path.join(dir, `${safeKey(key)}${ext}`);
  const write = async (p, data) => {
    await fs.mkdir(path.dirname(p), { recursive: true });
    const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
    await fs.writeFile(tmp, data);
    await fs.rename(tmp, p); // atomic replace
  };
  const read = (p, enc) => fs.readFile(p, enc).catch((e) => (e.code === 'ENOENT' ? null : Promise.reject(e)));
  return {
    async get(key) {
      const text = await read(file(key, '.json'), 'utf8');
      return text === null ? null : JSON.parse(text);
    },
    set: (key, value) => write(file(key, '.json'), JSON.stringify(value, null, 1)),
    async delete(key) {
      await fs.rm(file(key, '.json'), { force: true });
      await fs.rm(file(key, '.bin'), { force: true });
    },
    async list(prefix) {
      const base = path.join(dir, safeKey(prefix));
      const names = await fs.readdir(base).catch(() => []);
      return names.filter((n) => n.endsWith('.json')).map((n) => `${prefix}${prefix.endsWith('/') ? '' : '/'}${n.slice(0, -5)}`);
    },
    async getBlob(key) {
      const [data, meta] = await Promise.all([read(file(key, '.bin')), this.get(key)]);
      return data ? { data, type: meta?.type || 'application/octet-stream' } : null;
    },
    async setBlob(key, data, type) {
      await write(file(key, '.bin'), data);
      await this.set(key, { type });
    },
  };
}

export async function netlifyStore() {
  const { getStore } = await import('@netlify/blobs');
  const store = getStore({ name: 'curb-appeal', consistency: 'strong' });
  return {
    get: (key) => store.get(safeKey(key), { type: 'json' }),
    set: (key, value) => store.setJSON(safeKey(key), value),
    delete: (key) => store.delete(safeKey(key)),
    async list(prefix) {
      const { blobs } = await store.list({ prefix: safeKey(prefix) });
      return blobs.map((b) => b.key);
    },
    async getBlob(key) {
      const res = await store.getWithMetadata(`bin/${safeKey(key)}`, { type: 'arrayBuffer' });
      return res ? { data: new Uint8Array(res.data), type: res.metadata?.type || 'application/octet-stream' } : null;
    },
    setBlob: (key, data, type) => store.set(`bin/${safeKey(key)}`, data, { metadata: { type } }),
  };
}
