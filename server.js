// Plain Node server: serves the site from ./public and the API from src/app.js.
// Use it for local development, or to run the site on any host with Node
// and a persistent disk. (On Netlify, netlify/functions/api.mjs is used instead.)
//
//   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='choose-a-long-one' npm start

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { createApp } from './src/app.js';
import { fileStore } from './src/store.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const dataDir = process.env.DATA_DIR || path.join(root, 'data');
const port = Number(process.env.PORT) || 3000;
const handle = createApp(fileStore(dataDir), process.env);

const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.json': 'application/json' };
const MAX_BODY = 40 * 1024 * 1024;

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/api/')) {
      if (Number(req.headers['content-length'] || 0) > MAX_BODY) { res.writeHead(413).end(); return; }
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      const response = await handle(new Request(url, { method: req.method, headers: req.headers, body: hasBody ? Readable.toWeb(req) : undefined, duplex: 'half' }));
      res.writeHead(response.status, Object.fromEntries(response.headers));
      res.end(Buffer.from(await response.arrayBuffer()));
      return;
    }
    // Static files. Resolve inside ./public only.
    let rel = decodeURIComponent(url.pathname);
    if (rel.endsWith('/')) rel += 'index.html';
    let file = path.join(publicDir, rel);
    if (!file.startsWith(publicDir + path.sep)) { res.writeHead(403).end(); return; }
    if (!path.extname(file) && fs.existsSync(`${file}.html`)) file += '.html'; // /portal -> portal.html
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) { res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found'); return; }
    res.writeHead(200, { 'content-type': TYPES[path.extname(file)] || 'application/octet-stream', 'cache-control': 'no-cache' });
    fs.createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
});

server.listen(port, () => {
  console.log(`Curb Appeal running at http://localhost:${port}`);
  if (!process.env.ADMIN_EMAIL || !process.env.ADMIN_PASSWORD) {
    console.log('Owner sign-in is OFF. Set ADMIN_EMAIL and ADMIN_PASSWORD to enable the admin area.');
  }
});
