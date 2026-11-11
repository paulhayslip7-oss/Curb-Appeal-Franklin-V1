// Netlify entry point: every /api/* request is handled by src/app.js,
// with data kept in Netlify Blobs.
import { createApp } from '../../src/app.js';
import { netlifyStore } from '../../src/store.js';

let handle;
export default async (req) => {
  handle ??= createApp(await netlifyStore(), {
    ADMIN_EMAIL: Netlify.env.get('ADMIN_EMAIL'),
    ADMIN_PASSWORD: Netlify.env.get('ADMIN_PASSWORD'),
    SESSION_SECRET: Netlify.env.get('SESSION_SECRET'),
  });
  return handle(req);
};

export const config = { path: '/api/*' };
