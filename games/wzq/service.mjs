import { randomBytes, randomInt } from 'node:crypto';

import { readBody, sendJson, rateLimit, openEvents, describeRooms, fail, validName, pushRoom } from '../../lib/transport.mjs';

export function createGameService() {
  const BOARD_SIZE = 15;
  const WIN_LENGTH = 5;
  const PLAYER_COUNT = 2;
  const SEAT_RESERVE_MS = 2 * 60 * 1000;
  const ROOM_TTL_MS = 30 * 60 * 1000;
  const MAX_ROOMS = 200;
  const rooms = new Map();
  const sessions = new Map();

  function token() { return randomBytes(24).toString('hex'); }
  function log(room, message) { room.log = [...room.log.slice(-39), { id: token().slice(0, 8), message }]; }
  function nextSeat(seat) { return (seat + 1) % PLAYER_COUNT; }
  function newBoard() { return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)); }
  function newPlayer(name, seat) { return { token: token(), name, seat, online: true, offlineAt: 0, score: 0, ready: false, requests: [] }; }
  function bindSession(room, player) { sessions.set(player.token, { room, player, stream: null, requests: [] }); }
  function view(room, player) {
    return {
      code: room.code,
      you: player.seat,
      host: room.host,
      players: room.players.map(entry => entry ? { seat: entry.seat, name: entry.name, online: entry.online, score: entry.score, ready: entry.ready } : null),
      phase: room.phase,
      turn: room.turn,
      board: room.board,
      moves: room.moves,
      lastMove: room.moves.at(-1) || null,
      winner: room.winner,
      undoRequest: room.undoRequest,
      rematchVotes: room.rematchVotes,
      deadline: room.deadline,
      serverTime: Date.now(),
      log: room.log
    };
  }
  function push(room) { pushRoom(room, sessions, view); }
  function makeRoom(name) {
    if (rooms.size >= MAX_ROOMS) { fail('房间数量已满，请稍后再试。', 503); }
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
    const room = {
      code, host: 0, players: [newPlayer(name, 0), null], board: newBoard(), moves: [],
      phase: 'waiting', turn: 0, winner: null, undoRequest: null, rematchVotes: [],
      log: [], updatedAt: Date.now(), deadline: 0
    };
    rooms.set(code, room);
    bindSession(room, room.players[0]);
    log(room, `${name} 创建了房间`);
    return room;
  }
  function requireSession(value) {
    const session = typeof value === 'string' ? sessions.get(value) : null;
    if (!session) { fail('会话已过期，请重新加入。', 401); }
    return session;
  }
  function validCoordinate(value) { return Number.isInteger(value) && value >= 0 && value < BOARD_SIZE; }
  function hasFive(board, row, column, color) {
    const directions = [[0, 1], [1, 0], [1, 1], [1, -1]];
    for (const [rowStep, columnStep] of directions) {
      let count = 1;
      for (const sign of [-1, 1]) {
        let nextRow = row + rowStep * sign;
        let nextColumn = column + columnStep * sign;
        while (nextRow >= 0 && nextRow < BOARD_SIZE && nextColumn >= 0 && nextColumn < BOARD_SIZE && board[nextRow][nextColumn] === color) {
          count++;
          nextRow += rowStep * sign;
          nextColumn += columnStep * sign;
        }
      }
      if (count >= WIN_LENGTH) { return true; }
    }
    return false;
  }
  function startGame(room) {
    room.board = newBoard();
    room.moves = [];
    room.phase = 'playing';
    room.turn = 0;
    room.winner = null;
    room.undoRequest = null;
    room.rematchVotes = [];
    for (const player of room.players) { player.ready = false; }
    log(room, '新对局开始，黑棋先行。');
  }
  function roomAction(room, player, path, body) {
    if (path === '/api/ready') {
      if (!['waiting', 'finished'].includes(room.phase)) { fail('对局进行中。'); }
      if (typeof body.ready !== 'boolean') { fail('准备状态无效。'); }
      player.ready = body.ready;
      if (room.phase === 'finished') {
        if (body.ready) { room.rematchVotes = [...new Set([...room.rematchVotes, player.seat])]; }
        else { room.rematchVotes = room.rematchVotes.filter(seat => seat !== player.seat); }
        if (room.rematchVotes.length === PLAYER_COUNT) { startGame(room); }
      }
      return;
    }
    if (path === '/api/start') {
      if (room.host !== player.seat) { fail('仅房主可操作。'); }
      if (room.phase !== 'waiting') { fail('对局进行中。'); }
      if (!room.players.every(entry => entry?.online && entry.ready)) { fail('双方都需要准备。'); }
      startGame(room);
      return;
    }
    if (path === '/api/move') {
      if (room.phase !== 'playing') { fail('对局尚未开始。'); }
      if (room.undoRequest) { fail('请先处理悔棋请求。'); }
      if (room.turn !== player.seat) { fail('请等待你的回合。'); }
      if (!validCoordinate(body.row) || !validCoordinate(body.column)) { fail('落点无效。'); }
      if (room.board[body.row][body.column] !== null) { fail('这里已有棋子。'); }
      const color = player.seat === 0 ? 'black' : 'white';
      room.board[body.row][body.column] = color;
      const move = { row: body.row, column: body.column, color, seat: player.seat, name: player.name };
      room.moves.push(move);
      if (hasFive(room.board, body.row, body.column, color)) {
        room.phase = 'finished';
        room.winner = player.seat;
        player.score++;
        log(room, `${player.name} 获胜`);
      } else if (room.moves.length === BOARD_SIZE * BOARD_SIZE) {
        room.phase = 'finished';
        room.winner = null;
        log(room, '和棋。');
      } else {
        room.turn = nextSeat(player.seat);
        log(room, `${color === 'black' ? '黑棋' : '白棋'} · ${body.column + 1}, ${body.row + 1}`);
      }
      room.undoRequest = null;
      room.rematchVotes = [];
      room.players.forEach(entry => { entry.ready = false; });
      return;
    }
    if (path === '/api/undo/request') {
      if (room.phase !== 'playing') { fail('对局尚未开始。'); }
      if (room.undoRequest) { fail('已有悔棋请求。'); }
      if (room.moves.length === 0) { fail('暂无可撤回的落子。'); }
      if (room.moves.at(-1).seat === player.seat) { fail('暂无对方落子可撤回。'); }
      room.undoRequest = { from: player.seat, to: nextSeat(player.seat) };
      log(room, `${player.name} 申请悔棋`);
      return;
    }
    if (path === '/api/undo/respond') {
      if (!room.undoRequest) { fail('没有待处理的悔棋请求。'); }
      const requesterCancels = body.cancel === true && room.undoRequest.from === player.seat;
      if (!requesterCancels && room.undoRequest.to !== player.seat) { fail('没有待处理的悔棋请求。'); }
      const accepted = !requesterCancels && body.accept === true;
      if (accepted) {
        const move = room.moves.pop();
        room.board[move.row][move.column] = null;
        room.turn = move.seat;
        log(room, '已同意悔棋。');
      } else { log(room, requesterCancels ? '已取消悔棋。' : '已拒绝悔棋。'); }
      room.undoRequest = null;
      return;
    }
    fail('未知操作。', 404);
  }
  function removePlayer(room, player) {
    const session = sessions.get(player.token);
    sessions.delete(player.token);
    if (session?.stream) { session.stream.end(); }
    room.players[player.seat] = null;
    log(room, `${player.name} 离开了房间`);
    const remaining = room.players.filter(Boolean);
    if (remaining.length === 0) { rooms.delete(room.code); return; }
    if (room.host === player.seat) { room.host = remaining[0].seat; }
    room.phase = 'waiting';
    room.board = newBoard();
    room.moves = [];
    room.turn = 0;
    room.winner = null;
    room.undoRequest = null;
    room.rematchVotes = [];
    remaining.forEach(entry => { entry.ready = false; });
    log(room, '对方已离开，对局已重置。');
    push(room);
  }
  async function api(request, response, path) {
    const body = await readBody(request);
    if (path === '/api/create') {
      const room = makeRoom(validName(body.name));
      sendJson(response, { token: room.players[0].token, state: view(room, room.players[0]) });
      return;
    }
    if (path === '/api/join') {
      const name = validName(body.name);
      const room = rooms.get(String(body.code));
      if (!room) { fail('房间不存在。', 404); }
      const seat = room.players.findIndex(entry => !entry);
      if (seat < 0) { fail('房间已满。'); }
      if (room.players.some(entry => entry?.name === name)) { fail('昵称已被使用。'); }
      const player = newPlayer(name, seat);
      room.players[seat] = player;
      bindSession(room, player);
      log(room, `${name} 加入了房间`);
      push(room);
      sendJson(response, { token: player.token, state: view(room, player) });
      return;
    }
    const session = requireSession(request.headers.authorization?.replace(/^Bearer /, ''));
    const { room, player } = session;
    rateLimit(session);
    if (path === '/api/resume') { sendJson(response, { state: view(room, player) }); return; }
    if (path === '/api/leave') { removePlayer(room, player); sendJson(response, { ok: true }); return; }
    if (!room.players.every(Boolean) && path !== '/api/resume') { fail('等待另一位玩家加入。'); }
    roomAction(room, player, path, body);
    push(room);
    sendJson(response, { state: view(room, player) });
  }
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const expired = room.players.filter(player => player && !player.online && player.offlineAt && now - player.offlineAt > SEAT_RESERVE_MS);
      for (const player of expired) { if (rooms.has(room.code)) { removePlayer(room, player); } }
      if (!rooms.has(room.code)) { continue; }
      if (now - room.updatedAt > ROOM_TTL_MS && !room.players.some(player => player?.online)) { rooms.delete(room.code); }
    }
  }, 1000);

  return {
    handleApi: api,
    listRooms: () => describeRooms(rooms, 'wzq', 2),
    openEvents(request, response, token) {
      const session = requireSession(token);
      openEvents(request, response, session, () => {
        if (rooms.has(session.room.code)) { push(session.room); }
      });
    },
    close() {
      clearInterval(maintenance);
      for (const session of sessions.values()) { session.stream?.end(); }
    }
  };
}
