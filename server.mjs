import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { networkInterfaces } from 'node:os';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { createGameService as createCards } from './games/ddz/service.mjs';
import { createGameService as createGomoku } from './games/wzq/service.mjs';
import { createGameService as createMahjong } from './games/mj/service.mjs';
import { fail, sendJson, rateLimit } from './lib/transport.mjs';

export const GAME_CATALOG = [
  { id: 'ddz', name: 'Cards', capacity: 3, description: 'One solo. One team.', path: '/games/ddz/' },
  { id: 'wzq', name: 'Gomoku', capacity: 2, description: 'Five in a row.', path: '/games/wzq/' },
  { id: 'mj', name: 'Mahjong', capacity: 4, description: 'Four seats. One table.', path: '/games/mj/' }
];

const MIME_TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
const ROOT_ASSETS = new Set(['index.html', 'app.js', 'style.css', 'bridge.js', 'platform.css']);
const GAME_ASSETS = new Set(['index.html', 'app.js', 'style.css']);
const FRONT_DOOR_LIMIT = 80;
const FRONT_DOOR_WINDOW_MS = 10000;

function lanAddresses(port) {
  return [...new Set(Object.values(networkInterfaces()).flat()
    .filter((entry) => entry && entry.family === 'IPv4' && !entry.internal)
    .map((entry) => `http://${entry.address}:${port}`))];
}

function validateOrigin(request) {
  if (!request.headers.origin) { return; }
  let origin;
  try { origin = new URL(request.headers.origin); }
  catch { fail('Invalid origin.', 403); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) {
    fail('Invalid origin.', 403);
  }
}

export function createPlatform() {
  const services = new Map([['ddz', createCards()], ['wzq', createGomoku()], ['mj', createMahjong()]]);
  const entryRequests = new Map();
  const cleanup = setInterval(() => {
    for (const [address, bucket] of entryRequests) {
      if (bucket.requests.at(-1) < Date.now() - FRONT_DOOR_WINDOW_MS) { entryRequests.delete(address); }
    }
  }, FRONT_DOOR_WINDOW_MS);
  const server = http.createServer(async (request, response) => {
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Referrer-Policy', 'no-referrer');
    response.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    try {
      const url = new URL(request.url, 'http://localhost');
      const port = server.address().port;
      if (request.method === 'GET' && ['/api/lobby', '/api/info'].includes(url.pathname)) {
        const info = { addresses: lanAddresses(port), port };
        if (url.pathname === '/api/lobby') {
          info.games = GAME_CATALOG;
          info.rooms = [...services.values()].flatMap((service) => service.listRooms())
            .sort((first, second) => second.updatedAt - first.updatedAt);
        }
        sendJson(response, info);
        return;
      }
      const match = /^\/games\/(ddz|wzq|mj)(\/.*)?$/.exec(url.pathname);
      if (match) {
        const [, game, gamePath] = match;
        if (!gamePath) {
          response.writeHead(308, { Location: `/games/${game}/${url.search}` });
          response.end();
          return;
        }
        const service = services.get(game);
        if (request.method === 'POST' && gamePath.startsWith('/api/')) {
          validateOrigin(request);
          if (['/api/create', '/api/join'].includes(gamePath)) {
            const address = request.socket.remoteAddress;
            const bucket = entryRequests.get(address) || { requests: [] };
            rateLimit(bucket, FRONT_DOOR_LIMIT);
            entryRequests.set(address, bucket);
          }
          await service.handleApi(request, response, gamePath);
          return;
        }
        if (request.method === 'GET' && gamePath === '/events') {
          service.openEvents(request, response, url.searchParams.get('token'));
          return;
        }
        if (request.method !== 'GET') { fail('Method not allowed.', 405); }
        const filename = gamePath === '/' ? 'index.html' : gamePath.slice(1);
        if (!GAME_ASSETS.has(filename)) { fail('Not found.', 404); }
        await serveFile(response, new URL(`./games/${game}/public/${filename}`, import.meta.url), filename);
        return;
      }
      if (request.method !== 'GET') { fail('Method not allowed.', 405); }
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!ROOT_ASSETS.has(filename)) { fail('Not found.', 404); }
      await serveFile(response, new URL(`./public/${filename}`, import.meta.url), filename);
    } catch (error) {
      if (!error.status) { console.error('Request failed:', error); }
      if (!response.headersSent) { sendJson(response, { error: error.status ? error.message : 'Server error. Retry.' }, error.status || 500); }
      else { response.end(); }
    }
  });
  server.requestTimeout = 15000;
  server.headersTimeout = 10000;
  let closed = false;
  function stopGames() {
    if (closed) { return; }
    closed = true;
    clearInterval(cleanup);
    for (const service of services.values()) { service.close(); }
  }
  server.on('close', stopGames);
  server.on('error', stopGames);
  return { server, close() { stopGames(); server.close(); server.closeIdleConnections(); } };
}

async function serveFile(response, url, filename) {
  const content = await readFile(url);
  response.writeHead(200, { 'Content-Type': `${MIME_TYPES[filename.split('.').at(-1)]}; charset=utf-8`, 'Cache-Control': 'no-cache' });
  response.end(content);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 3000);
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('PORT must be between 1 and 65535.'); }
  const platform = createPlatform();
  platform.server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `Port ${port} busy. Choose another PORT.` : error.message);
    process.exitCode = 1;
  });
  platform.server.listen(port, '0.0.0.0', () => {
    console.log(`\n  LAN · Game Lobby\n  Local: http://localhost:${port}\n${lanAddresses(port).map((address) => `  LAN: ${address}`).join('\n')}\n\n  Share one LAN address. All three games are ready.\n  Keep this window open. Ctrl+C to stop.\n`);
  });
  process.on('SIGINT', () => { platform.close(); });
  process.on('SIGTERM', () => { platform.close(); });
}
