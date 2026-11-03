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
    if (rooms.size >= MAX_ROOMS) { fail('Server full. Try later.', 503); }
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
    const room = {
      code, host: 0, players: [newPlayer(name, 0), null], board: newBoard(), moves: [],
      phase: 'waiting', turn: 0, winner: null, undoRequest: null, rematchVotes: [],
      log: [], updatedAt: Date.now(), deadline: 0
    };
    rooms.set(code, room);
    bindSession(room, room.players[0]);
    log(room, `${name} created room`);
    return room;
  }
  function requireSession(value) {
    const session = typeof value === 'string' ? sessions.get(value) : null;
    if (!session) { fail('Session expired. Rejoin.', 401); }
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
    log(room, 'New game. Black moves first.');
  }
  function roomAction(room, player, path, body) {
    if (path === '/api/ready') {
      if (!['waiting', 'finished'].includes(room.phase)) { fail('Game in progress.'); }
      if (typeof body.ready !== 'boolean') { fail('Invalid ready state.'); }
      player.ready = body.ready;
      if (room.phase === 'finished') {
        if (body.ready) { room.rematchVotes = [...new Set([...room.rematchVotes, player.seat])]; }
        else { room.rematchVotes = room.rematchVotes.filter(seat => seat !== player.seat); }
        if (room.rematchVotes.length === PLAYER_COUNT) { startGame(room); }
      }
      return;
    }
    if (path === '/api/start') {
      if (room.host !== player.seat) { fail('Host only.'); }
      if (room.phase !== 'waiting') { fail('Game in progress.'); }
      if (!room.players.every(entry => entry?.online && entry.ready)) { fail('Both players must be ready.'); }
      startGame(room);
      return;
    }
    if (path === '/api/move') {
      if (room.phase !== 'playing') { fail('Game is not active.'); }
      if (room.undoRequest) { fail('Undo pending.'); }
      if (room.turn !== player.seat) { fail('Wait your turn.'); }
      if (!validCoordinate(body.row) || !validCoordinate(body.column)) { fail('Invalid square.'); }
      if (room.board[body.row][body.column] !== null) { fail('Square occupied.'); }
      const color = player.seat === 0 ? 'black' : 'white';
      room.board[body.row][body.column] = color;
      const move = { row: body.row, column: body.column, color, seat: player.seat, name: player.name };
      room.moves.push(move);
      if (hasFive(room.board, body.row, body.column, color)) {
        room.phase = 'finished';
        room.winner = player.seat;
        player.score++;
        log(room, `${player.name} wins`);
      } else if (room.moves.length === BOARD_SIZE * BOARD_SIZE) {
        room.phase = 'finished';
        room.winner = null;
        log(room, 'Draw.');
      } else {
        room.turn = nextSeat(player.seat);
        log(room, `${color === 'black' ? 'Black' : 'White'} · ${body.column + 1}, ${body.row + 1}`);
      }
      room.undoRequest = null;
      room.rematchVotes = [];
      room.players.forEach(entry => { entry.ready = false; });
      return;
    }
    if (path === '/api/undo/request') {
      if (room.phase !== 'playing') { fail('Game is not active.'); }
      if (room.undoRequest) { fail('Undo already pending.'); }
      if (room.moves.length === 0) { fail('Nothing to undo.'); }
      if (room.moves.at(-1).seat === player.seat) { fail('No opponent move to undo.'); }
      room.undoRequest = { from: player.seat, to: nextSeat(player.seat) };
      log(room, `${player.name} requests undo`);
      return;
    }
    if (path === '/api/undo/respond') {
      if (!room.undoRequest) { fail('No undo request.'); }
      const requesterCancels = body.cancel === true && room.undoRequest.from === player.seat;
      if (!requesterCancels && room.undoRequest.to !== player.seat) { fail('No undo request.'); }
      const accepted = !requesterCancels && body.accept === true;
      if (accepted) {
        const move = room.moves.pop();
        room.board[move.row][move.column] = null;
        room.turn = move.seat;
        log(room, 'Undo accepted.');
      } else { log(room, requesterCancels ? 'Undo cancelled.' : 'Undo declined.'); }
      room.undoRequest = null;
      return;
    }
    fail('Unknown action.', 404);
  }
  function removePlayer(room, player) {
    const session = sessions.get(player.token);
    sessions.delete(player.token);
    if (session?.stream) { session.stream.end(); }
    room.players[player.seat] = null;
    log(room, `${player.name} left`);
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
    log(room, 'Opponent left. Game reset.');
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
      if (!room) { fail('Room not found.', 404); }
      const seat = room.players.findIndex(entry => !entry);
      if (seat < 0) { fail('Room full.'); }
      if (room.players.some(entry => entry?.name === name)) { fail('Name taken.'); }
      const player = newPlayer(name, seat);
      room.players[seat] = player;
      bindSession(room, player);
      log(room, `${name} joined`);
      push(room);
      sendJson(response, { token: player.token, state: view(room, player) });
      return;
    }
    const session = requireSession(request.headers.authorization?.replace(/^Bearer /, ''));
    const { room, player } = session;
    rateLimit(session);
    if (path === '/api/resume') { sendJson(response, { state: view(room, player) }); return; }
    if (path === '/api/leave') { removePlayer(room, player); sendJson(response, { ok: true }); return; }
    if (!room.players.every(Boolean) && path !== '/api/resume') { fail('Waiting for another player.'); }
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
