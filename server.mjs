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
  { id: 'ddz', name: '斗地主', capacity: 3, description: '一位地主，两位农民。', path: '/games/ddz/' },
  { id: 'wzq', name: '五子棋', capacity: 2, description: '五子连珠，先到先赢。', path: '/games/wzq/' },
  { id: 'mj', name: '麻将', capacity: 4, description: '四人一桌，摸打之间。', path: '/games/mj/' },
  { id: 'snake', name: '贪吃蛇', capacity: 1, mode: 'arcade', description: '吃点心，慢慢长大。', path: '/games/snake/' },
  { id: 'tetris', name: '俄罗斯方块', capacity: 1, mode: 'arcade', description: '转一转，消去整行。', path: '/games/tetris/' },
  { id: 'tank', name: '90坦克', capacity: 2, mode: 'arcade', description: '守住基地，并肩闯关。', path: '/games/tank/' },
  { id: 'sokoban', name: '推箱子', capacity: 1, mode: 'arcade', description: '一步一步，把箱子归位。', path: '/games/sokoban/' }
];

const MIME_TYPES = { html: 'text/html', js: 'text/javascript', css: 'text/css' };
const ROOT_ASSETS = new Set(['index.html', 'app.js', 'style.css', 'bridge.js', 'platform.css']);
const GAME_ASSETS = new Set(['index.html', 'app.js', 'style.css']);
const ARCADE_ASSETS = new Set(['app.js', 'core.js', 'snake.js', 'tetris.js', 'tank.js', 'sokoban.js', 'style.css']);
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
  catch { fail('请求来源无效。', 403); }
  if (!['http:', 'https:'].includes(origin.protocol) || origin.host !== request.headers.host) {
    fail('请求来源无效。', 403);
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
      const arcadeAsset = /^\/arcade\/([^/]+)$/.exec(url.pathname);
      if (arcadeAsset && request.method === 'GET' && ARCADE_ASSETS.has(arcadeAsset[1])) {
        await serveFile(response, new URL(`./public/arcade/${arcadeAsset[1]}`, import.meta.url), arcadeAsset[1]);
        return;
      }
      const match = /^\/games\/(ddz|wzq|mj|snake|tetris|tank|sokoban)(\/.*)?$/.exec(url.pathname);
      if (match) {
        const [, game, gamePath] = match;
        if (!gamePath) {
          response.writeHead(308, { Location: `/games/${game}/${url.search}` });
          response.end();
          return;
        }
        const service = services.get(game);
        if (!service) {
          if (request.method !== 'GET' || !['/', '/index.html'].includes(gamePath)) { fail('页面不存在。', 404); }
          await serveFile(response, new URL('./public/arcade/index.html', import.meta.url), 'index.html');
          return;
        }
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
        if (request.method !== 'GET') { fail('不支持此请求方式。', 405); }
        const filename = gamePath === '/' ? 'index.html' : gamePath.slice(1);
        if (!GAME_ASSETS.has(filename)) { fail('页面不存在。', 404); }
        await serveFile(response, new URL(`./games/${game}/public/${filename}`, import.meta.url), filename);
        return;
      }
      if (request.method !== 'GET') { fail('不支持此请求方式。', 405); }
      const filename = url.pathname === '/' ? 'index.html' : url.pathname.slice(1);
      if (!ROOT_ASSETS.has(filename)) { fail('页面不存在。', 404); }
      await serveFile(response, new URL(`./public/${filename}`, import.meta.url), filename);
    } catch (error) {
      if (!error.status) { console.error('Request failed:', error); }
      if (!response.headersSent) { sendJson(response, { error: error.status ? error.message : '服务异常，请重试。' }, error.status || 500); }
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
  if (!Number.isInteger(port) || port < 1 || port > 65535) { throw new Error('端口必须为 1 到 65535 之间的整数。'); }
  const platform = createPlatform();
  platform.server.on('error', (error) => {
    console.error(error.code === 'EADDRINUSE' ? `端口 ${port} 已占用，请通过 PORT 选择其他端口。` : error.message);
    process.exitCode = 1;
  });
  platform.server.listen(port, '0.0.0.0', () => {
    console.log(`\n  局域网游戏大厅\n  本机地址：http://localhost:${port}\n${lanAddresses(port).map((address) => `  局域网地址：${address}`).join('\n')}\n\n  分享局域网地址，即可进入七款游戏。\n  请保持此窗口运行，按 Ctrl+C 停止服务。\n`);
  });
  process.on('SIGINT', () => { platform.close(); });
  process.on('SIGTERM', () => { platform.close(); });
}
