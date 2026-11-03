const MAX_BODY_BYTES = 8192;
const RATE_WINDOW_MS = 10000;
const MAX_ACTIONS_PER_WINDOW = 60;
const HEARTBEAT_MS = 15000;

export function fail(message, status = 400) {
  throw Object.assign(new Error(message), { status });
}

export function validName(value, maxLength = 16) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name || [...name].length > maxLength || /[\x00-\x1f\x7f]/.test(name)) {
    fail(`昵称需为 1–${maxLength} 个字符。`);
  }
  return name;
}

export function pushRoom(room, sessions, view) {
  room.updatedAt = Date.now();
  for (const player of room.players.filter(Boolean)) {
    const session = sessions.get(player.token);
    if (session?.stream && !session.stream.destroyed) {
      session.stream.write(`data: ${JSON.stringify(view(room, player))}\n\n`);
    }
  }
}

export async function readBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) { fail('请求内容过大。', 413); }
    chunks.push(chunk);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { fail('请求无效。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) { fail('请求无效。'); }
  return body;
}

export function sendJson(response, body, status = 200) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(body));
}

export function rateLimit(session, limit = MAX_ACTIONS_PER_WINDOW) {
  const now = Date.now();
  session.requests = session.requests.filter((time) => time > now - RATE_WINDOW_MS);
  if (session.requests.length >= limit) { fail('操作太快，请稍后再试。', 429); }
  session.requests.push(now);
}

export function openEvents(request, response, session, push) {
  session.stream?.end();
  session.stream = response;
  session.player.online = true;
  session.player.offlineAt = 0;
  response.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform', Connection: 'keep-alive', 'X-Accel-Buffering': 'no'
  });
  response.write('retry: 2000\n\n');
  const heartbeat = setInterval(() => { response.write(': heartbeat\n\n'); }, HEARTBEAT_MS);
  response.on('close', () => {
    clearInterval(heartbeat);
    if (session.stream !== response) { return; }
    session.stream = null;
    session.player.online = false;
    session.player.offlineAt = Date.now();
    push();
  });
  push();
}

// Only public table metadata leaves the game service; never hands or session tokens.
export function describeRooms(rooms, game, capacity) {
  return [...rooms.values()].filter((room) => !room.practice).map((room) => {
    const players = room.players.filter(Boolean);
    return {
      game, code: room.code, host: room.players[room.host]?.name || '玩家',
      players: players.length, online: players.filter((player) => player.online).length,
      capacity, phase: room.phase,
      joinable: room.phase === 'waiting' && players.length < capacity,
      updatedAt: room.updatedAt
    };
  });
}
