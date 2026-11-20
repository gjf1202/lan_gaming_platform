import { randomBytes, randomInt } from 'node:crypto';
import { PLAYER_COUNT, HAND_SIZE, makeDeck, shuffledDeck, sortCards, legalMoves, resolvePlay } from './game.mjs';

import { readBody, sendJson, rateLimit, openEvents, openRoomWatcher, pushRoomWatchers, closeRoomWatchers, describeRooms, fail, validName, pushRoom, addRoomChatMessage } from '../../lib/transport.mjs';
const json = sendJson;

export function createGameService() {
  const BASE_SCORE = 1;
  const TURN_MS = 45000;
  const GRAB_MS = 20000;
  const RESERVE_MS = 120000;
  const ROOM_TTL_MS = 30 * 60 * 1000;
  const MAX_ROOMS = 100;
  const rooms = new Map();
  const sessions = new Map();

  function token() { return randomBytes(24).toString('hex'); }
  function currentPlayer(room) { return room.players[room.turn]; }
  function nextSeat(seat) { return (seat + 1) % PLAYER_COUNT; }
  function log(room, message, sound = null) { room.log = [...room.log.slice(-29), { id: token().slice(0, 8), message, sound }]; }
  function setTurn(room, seat) {
    room.turn = seat;
    room.deadline = Date.now() + (room.phase === 'grabbing' ? GRAB_MS : TURN_MS);
    room.botAt = room.players[seat]?.bot ? Date.now() + 1100 : 0;
  }
  function view(room, player) {
    const reveal = room.phase === 'finished';
    const target = room.lastPlay && room.lastPlay.seat !== room.turn ? room.lastPlay.pattern : null;
    return {
      code: room.code, practice: room.practice, noShuffle: room.noShuffle, phase: room.phase, you: player.seat,
      host: room.host, turn: room.turn, deadline: room.deadline, serverTime: Date.now(),
      landlord: room.landlord, baseScore: BASE_SCORE, multiplier: room.multiplier, round: room.round,
      grabCount: room.grabCount, grabResponses: room.grabResponses,
      bottom: room.landlord === null ? [] : room.bottom,
      hand: sortCards(player.hand), lastPlay: room.lastPlay, table: room.table, playedCards: room.playedCards,
      winner: room.winner, result: room.result, log: room.log, chat: room.chat,
      canBeat: room.phase === 'playing' && room.turn === player.seat ? legalMoves(player.hand, target).length > 0 : false,
      players: room.players.map(entry => entry ? {
        seat: entry.seat, name: entry.name, ready: entry.ready, online: entry.online,
        bot: entry.bot, count: entry.hand.length, score: entry.score, grabbed: entry.grabbed,
        cards: reveal ? sortCards(entry.hand) : []
      } : null)
    };
  }
  function spectatorView(room) {
    const state = view(room, { seat: 0, hand: [] });
    return {
      ...state,
      you: null,
      hand: [],
      canBeat: false,
      chat: undefined,
      players: state.players.map(player => player ? { ...player, cards: [] } : null),
      spectator: true
    };
  }
  function push(room) {
    pushRoom(room, sessions, view);
    pushRoomWatchers(room, spectatorView);
  }
  function newPlayer(name, seat, bot = false) {
    return { token: token(), name, seat, bot, online: true, offlineAt: 0, ready: bot, hand: [], score: 0, grabbed: null };
  }
  function bindSession(room, player) {
    sessions.set(player.token, { room, player, stream: null, requests: [] });
  }
  function makeRoom(name, practice, noShuffle) {
    if (rooms.size >= MAX_ROOMS) { fail('房间数量已满，请稍后再试。', 503); }
    let code;
    do { code = String(randomInt(100000, 1000000)); } while (rooms.has(code));
    const room = {
      code, practice, noShuffle, host: 0, players: [newPlayer(name, 0), null, null],
      phase: 'waiting', turn: null, landlord: null, bottom: [], lastPlay: null, playedCards: [],
      table: [null, null, null], grabCount: 0, grabbedSeats: [], grabResponses: Array(PLAYER_COUNT).fill(false), multiplier: 1,
      passes: 0, round: 0, log: [], chat: [], winner: null, result: null, updatedAt: Date.now(), deadline: 0
    };
    if (practice) {
      room.players[1] = newPlayer('机器人甲', 1, true);
      room.players[2] = newPlayer('机器人乙', 2, true);
    }
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

  function collectNoShuffleDeck(room) {
    const cards = [...room.playedCards];
    for (const player of room.players) {
      cards.push(...player.hand);
    }
    cards.push(...room.bottom);
    const seen = new Set();
    const collected = cards.filter(card => {
      if (seen.has(card.id)) { return false; }
      seen.add(card.id);
      return true;
    });
    if (collected.length < 54) {
      for (const card of makeDeck()) {
        if (!seen.has(card.id)) {
          collected.push(card);
          seen.add(card.id);
        }
      }
    }
    return collected;
  }

  function nextDeck(room) {
    if (!room.noShuffle) { return shuffledDeck(); }
    if (room.round === 0) { return shuffledDeck(); }
    return collectNoShuffleDeck(room);
  }

  function startRound(room) {
    const deck = nextDeck(room);
    room.phase = 'grabbing';
    room.round++;
    room.landlord = null;
    room.bottom = deck.slice(HAND_SIZE * PLAYER_COUNT);
    room.grabCount = 0; room.grabbedSeats = []; room.grabResponses = Array(PLAYER_COUNT).fill(false); room.multiplier = 1;
    room.lastPlay = null; room.passes = 0; room.table = [null, null, null];
    room.playedCards = [];
    room.winner = null; room.result = null;
    room.players.forEach((player, index) => {
      player.hand = sortCards(deck.slice(index * HAND_SIZE, (index + 1) * HAND_SIZE));
      player.grabbed = null; player.playCount = 0; player.ready = false;
    });
    setTurn(room, (room.round - 1) % PLAYER_COUNT);
    log(room, `第 ${room.round} 局：开始抢地主`);
  }
  function assignLandlord(room) {
    room.landlord = room.grabbedSeats.at(-1);
    const player = room.players[room.landlord];
    player.hand = sortCards([...player.hand, ...room.bottom]);
    room.phase = 'playing';
    setTurn(room, room.landlord);
    log(room, `${player.name} 抢到地主 · 倍数 ×${room.multiplier}`);
  }
  function grabLandlord(room, player, grab) {
    if (room.phase !== 'grabbing' || room.turn !== player.seat) { fail('请等待你的回合。'); }
    if (typeof grab !== 'boolean') { fail('抢地主选择无效。'); }
    player.grabbed = grab;
    room.grabResponses[player.seat] = true;
    if (grab) {
      room.grabbedSeats.push(player.seat);
      room.grabCount++;
      room.multiplier *= 2;
    }
    log(room, `${player.name} ${grab ? '抢地主' : '不抢'}`, grab ? 'grab' : 'pass');
    if (room.grabResponses.every(Boolean)) {
      if (room.grabbedSeats.length === 0) {
        log(room, '无人抢地主，重新发牌。');
        startRound(room);
      } else {
        assignLandlord(room);
      }
      return;
    }
    setTurn(room, nextSeat(room.turn));
  }
  function finishRound(room, player) {
    room.phase = 'finished';
    room.deadline = 0; room.botAt = 0;
    room.winner = player.seat;
    const landlordWon = player.seat === room.landlord;
    const spring = landlordWon ? room.players.filter(entry => entry.seat !== room.landlord).every(entry => entry.playCount === 0) : room.players[room.landlord].playCount <= 1;
    if (spring) { room.multiplier *= 2; }
    room.result = { landlordWon, spring, changes: room.players.map(entry => {
      const sideWon = (entry.seat === room.landlord) === landlordWon;
      const delta = (sideWon ? 1 : -1) * BASE_SCORE * room.multiplier * (entry.seat === room.landlord ? 2 : 1);
      entry.score += delta;
      entry.ready = entry.bot;
      return delta;
    }) };
    log(room, `${landlordWon ? '地主' : '农民'}获胜${spring ? ' · 春天 ×2' : ''}`);
  }
  function play(room, player, ids) {
    if (room.phase !== 'playing' || room.turn !== player.seat) { fail('请等待你的回合。'); }
    if (!Array.isArray(ids) || ids.length === 0 || ids.length > 20 || new Set(ids).size !== ids.length || ids.some(id => typeof id !== 'string')) { fail('请先选牌。'); }
    const selected = ids.map(id => player.hand.find(card => card.id === id));
    if (selected.some(card => !card)) { fail('选牌无效。'); }
    const target = room.lastPlay?.pattern || null;
    const resolved = resolvePlay(selected, target);
    if (!resolved) { fail(target ? '牌型不符或点数不够。' : '牌型无效。'); }
    player.hand = player.hand.filter(card => !ids.includes(card.id));
    room.playedCards.push(...selected);
    player.playCount++;
    room.lastPlay = { seat: player.seat, cards: sortCards(selected), pattern: resolved };
    room.table[player.seat] = { cards: sortCards(selected), text: resolved.name };
    room.passes = 0;
    if (resolved.type === 'bomb' || resolved.type === 'rocket') { room.multiplier *= 2; }
    log(room, `${player.name}: ${resolved.name}${player.hand.length <= 2 ? ` · 剩余 ${player.hand.length} 张` : ''}`, resolved.type === 'bomb' || resolved.type === 'rocket' ? 'bomb' : 'card');
    if (player.hand.length === 0) { finishRound(room, player); return; }
    setTurn(room, nextSeat(room.turn));
    room.table[room.turn] = null;
  }
  function pass(room, player) {
    if (room.phase !== 'playing' || room.turn !== player.seat) { fail('请等待你的回合。'); }
    if (!room.lastPlay || room.lastPlay.seat === player.seat) { fail('本轮由你先出，不能不要。'); }
    room.table[player.seat] = { cards: [], text: '不要' };
    room.passes++;
    log(room, `${player.name} 不要`, 'pass');
    if (room.passes === 2) {
      const leader = room.lastPlay.seat;
      room.lastPlay = null; room.passes = 0;
      room.table = [null, null, null];
      setTurn(room, leader);
      return;
    }
    setTurn(room, nextSeat(room.turn));
    room.table[room.turn] = null;
  }
  function automatedTurn(room) {
    const player = currentPlayer(room);
    if (room.phase === 'grabbing') {
      const strength = player.hand.filter(card => card.rank >= 15).length + legalMoves(player.hand).filter(move => move.pattern.type === 'bomb').length;
      grabLandlord(room, player, player.bot && strength >= 3);
    } else if (room.lastPlay) {
      const teammate = player.bot && player.seat !== room.landlord && room.lastPlay.seat !== room.landlord;
      const moves = player.bot && !teammate ? legalMoves(player.hand, room.lastPlay.pattern) : [];
      if (moves.length) { play(room, player, moves[0].cards.map(card => card.id)); }
      else { pass(room, player); }
    } else {
      const cards = player.bot ? legalMoves(player.hand)[0].cards : [player.hand.at(-1)];
      play(room, player, cards.map(card => card.id));
    }
  }
  function deleteRoom(room) {
    rooms.delete(room.code);
    closeRoomWatchers(room);
    for (const player of room.players.filter(Boolean)) {
      const session = sessions.get(player.token);
      if (session?.stream) { session.stream.end(); }
      sessions.delete(player.token);
    }
  }
  function removePlayer(room, player) {
    if (room.phase === 'playing' || room.phase === 'grabbing') {
      room.phase = 'waiting'; room.deadline = 0; room.botAt = 0;
      room.landlord = null; room.bottom = []; room.lastPlay = null; room.table = [null, null, null]; room.playedCards = [];
      room.result = null; room.winner = null; room.turn = null; room.grabCount = 0; room.grabbedSeats = []; room.grabResponses = Array(PLAYER_COUNT).fill(false); room.multiplier = 1;
      for (const entry of room.players.filter(Boolean)) { entry.hand = []; entry.ready = entry.bot; entry.grabbed = null; }
      log(room, '有玩家离开，本局已取消。');
    }
    const session = sessions.get(player.token);
    sessions.delete(player.token);
    if (session?.stream) { session.stream.end(); }
    room.players[player.seat] = null;
    log(room, `${player.name} 离开了房间`);
    const humans = room.players.filter(entry => entry && !entry.bot);
    if (humans.length === 0) { deleteRoom(room); return; }
    if (room.host === player.seat) { room.host = humans[0].seat; }
    push(room);
  }
  async function api(request, response, path) {
    const body = await readBody(request);
    if (path === '/api/create') {
      const room = makeRoom(validName(body.name, 12), body.practice === true, body.noShuffle === true);
      json(response, { token: room.players[0].token, state: view(room, room.players[0]) });
      return;
    }
    if (path === '/api/join') {
      const name = validName(body.name, 12);
      const room = rooms.get(String(body.code));
      if (!room || room.practice) { fail('房间不存在。', 404); }
      const seat = room.players.findIndex(player => !player);
      if (seat < 0) { fail('房间已满。'); }
      if (room.players.some(player => player?.name === name)) { fail('昵称已被使用。'); }
      const player = newPlayer(name, seat);
      room.players[seat] = player;
      bindSession(room, player);
      log(room, `${name} 加入了房间`);
      push(room);
      json(response, { token: player.token, state: view(room, player) });
      return;
    }
    const session = requireSession(request.headers.authorization?.replace(/^Bearer /, ''));
    const { room, player } = session;
    rateLimit(session);
    if (path === '/api/resume') { json(response, { state: view(room, player) }); return; }
    if (path === '/api/leave') { removePlayer(room, player); json(response, { ok: true }); return; }
    if (path === '/api/chat') {
      if (room.practice) { fail('练习房间不支持聊天室。'); }
      addRoomChatMessage(room, player, body.text);
      push(room);
      json(response, { state: view(room, player) });
      return;
    }
    if (path === '/api/ready') {
      if (!['waiting', 'finished'].includes(room.phase)) { fail('本局进行中。'); }
      if (typeof body.ready !== 'boolean') { fail('准备状态无效。'); }
      player.ready = body.ready;
    } else if (path === '/api/start') {
      if (room.host !== player.seat) { fail('仅房主可操作。'); }
      if (!['waiting', 'finished'].includes(room.phase)) { fail('本局进行中。'); }
      if (!room.players.every(entry => entry?.ready && entry.online)) { fail('三位玩家都需要准备。'); }
      startRound(room);
    } else if (path === '/api/grab') { grabLandlord(room, player, body.grab); }
    else if (path === '/api/play') { play(room, player, body.ids); }
    else if (path === '/api/pass') { pass(room, player); }
    else if (path === '/api/hint') {
      if (room.phase !== 'playing' || room.turn !== player.seat) { fail('请等待你的回合。'); }
      const moves = legalMoves(player.hand, room.lastPlay?.pattern || null);
      json(response, { moves: moves.slice(0, 80).map(move => move.cards.map(card => card.id)) });
      return;
    } else { fail('未知操作。', 404); }
    push(room);
    json(response, { state: view(room, player) });
  }

  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.values()) {
      const expired = room.players.filter(player => player && !player.bot && !player.online && player.offlineAt && now - player.offlineAt > RESERVE_MS);
      for (const player of expired) { if (rooms.has(room.code)) { removePlayer(room, player); } }
      if (!rooms.has(room.code)) { continue; }
      if (now - room.updatedAt > ROOM_TTL_MS && !room.players.some(player => player && !player.bot && player.online)) { deleteRoom(room); continue; }
      if (!['playing', 'grabbing'].includes(room.phase)) { continue; }
      if (now >= room.deadline || (room.botAt && now >= room.botAt)) {
        try { automatedTurn(room); push(room); }
        catch (error) { console.error('Automatic turn failed in room %s:', room.code, error); room.botAt = 0; room.deadline = now + TURN_MS; }
      }
    }
  }, 500);


  return {
    handleApi: api,
    listRooms: () => describeRooms(rooms, 'ddz', 3),
    openEvents(request, response, token, watchCode) {
      if (watchCode) {
        const room = rooms.get(String(watchCode));
        if (!room || room.practice) { fail('房间不存在。', 404); }
        openRoomWatcher(request, response, room, spectatorView);
        return;
      }
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
