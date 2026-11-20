const params = new URLSearchParams(location.search);
const game = params.get('game');
const code = params.get('room');
const gameNames = { ddz: '斗地主', wzq: '五子棋', mj: '麻将' };
const phaseNames = { waiting: '等待玩家', bidding: '叫分中', playing: '进行中', claim: '等待响应', finished: '本局结束' };
const byId = (id) => document.getElementById(id);
let stream;

function node(tag, className = '', text = '') {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}

function drawGomoku(board, lastMove) {
  const canvas = byId('gomoku-board');
  const context = canvas.getContext('2d');
  const size = canvas.width;
  const padding = 24;
  const spacing = (size - padding * 2) / 14;
  context.fillStyle = '#353631';
  context.fillRect(0, 0, size, size);
  context.strokeStyle = '#747468';
  context.lineWidth = 1;
  for (let index = 0; index < 15; index++) {
    const point = padding + spacing * index;
    context.beginPath();
    context.moveTo(padding, point);
    context.lineTo(size - padding, point);
    context.moveTo(point, padding);
    context.lineTo(point, size - padding);
    context.stroke();
  }
  for (let row = 0; row < 15; row++) {
    for (let column = 0; column < 15; column++) {
      const color = board[row][column];
      if (!color) { continue; }
      const x = padding + spacing * column;
      const y = padding + spacing * row;
      context.beginPath();
      context.fillStyle = color === 'black' ? '#111214' : '#e3e4e2';
      context.strokeStyle = color === 'black' ? '#777b80' : '#b8babe';
      context.arc(x, y, spacing * .43, 0, Math.PI * 2);
      context.fill();
      context.stroke();
      if (lastMove?.row === row && lastMove?.column === column) {
        context.strokeStyle = '#9dbdab';
        context.lineWidth = 2;
        context.strokeRect(x - 5, y - 5, 10, 10);
      }
    }
  }
}

function renderSeats(state) {
  const list = byId('players');
  list.replaceChildren(...state.players.map((player, seat) => {
    const status = !player ? '空位' : !player.online ? '离线' : player.ready ? '已准备' : '在线';
    const row = node('div', 'player-row');
    row.append(node('span', '', `${seat + 1} · ${player?.name || '等待加入'}`), node('span', '', status));
    return row;
  }));
}

function renderDdz(state) {
  const board = byId('ddz-board');
  board.hidden = false;
  byId('ddz-table').replaceChildren(...state.players.map((player, seat) => {
    const section = node('section', `public-seat${state.phase !== 'waiting' && state.turn === seat ? ' active' : ''}`);
    const header = node('header');
    header.append(node('strong', '', player?.name || `座位 ${seat + 1}`));
    header.append(node('span', '', `${player?.count ?? 0} 张`));
    section.append(header);
    if (state.landlord === seat) { section.append(node('p', '', '地主')); }
    if (state.phase === 'bidding' && player?.bid !== null) { section.append(node('p', '', player?.bid ? `叫 ${player.bid} 分` : '不叫')); }
    const played = state.table[seat];
    if (played?.cards?.length) {
      const cards = node('p');
      for (const card of played.cards) { cards.append(node('span', 'public-card', `${card.rank}${card.suit}`)); }
      section.append(cards);
    } else if (played?.text) { section.append(node('p', '', played.text)); }
    return section;
  }));
}

function renderMahjong(state) {
  byId('mj-board').hidden = false;
  byId('mj-table').replaceChildren(...state.players.map((player, seat) => {
    const section = node('section', `public-seat${state.phase !== 'waiting' && state.turn === seat ? ' active' : ''}`);
    const header = node('header');
    header.append(node('strong', '', `${['東', '南', '西', '北'][seat]} · ${player?.name || '空位'}`));
    header.append(node('span', '', player ? `${player.handCount} 張` : ''));
    section.append(header);
    if (player?.melds.length) { section.append(node('p', '', `副露：${player.melds.map((meld) => meld.type).join(' · ')}`)); }
    section.append(node('p', '', `棄牌：${player?.discards.map((discard) => discard.tile).join('　') || '—'}`));
    return section;
  }));
}

function render(state) {
  byId('room-number').textContent = state.code;
  byId('phase').textContent = phaseNames[state.phase] || state.phase;
  renderSeats(state);
  byId('public-board').hidden = game !== 'wzq';
  byId('ddz-board').hidden = game !== 'ddz';
  byId('mj-board').hidden = game !== 'mj';
  if (game === 'wzq') { drawGomoku(state.board, state.lastMove); }
  if (game === 'ddz') { renderDdz(state); }
  if (game === 'mj') { renderMahjong(state); }
  const entries = state.log.slice(-30).map((entry) => node('li', '', entry.message));
  byId('log').replaceChildren(...entries);
  byId('log').scrollTop = byId('log').scrollHeight;
}

function fail(message) {
  byId('error').textContent = message;
  byId('phase').textContent = '无法观战';
  byId('connection').lastChild.textContent = '未连接';
}

if (!gameNames[game] || !/^\d{6}$/.test(code || '')) {
  fail('观战链接无效，请从大厅房间列表进入。');
} else {
  document.title = '备忘录';
  byId('game-name').textContent = gameNames[game];
  stream = new EventSource(`/games/${game}/events?watch=${encodeURIComponent(code)}`);
  stream.onopen = () => { byId('connection').lastChild.textContent = '实时观战'; };
  stream.onmessage = (event) => {
    try { render(JSON.parse(event.data)); }
    catch { fail('房间状态读取失败。'); stream.close(); }
  };
  stream.onerror = () => { byId('connection').lastChild.textContent = '正在重连'; };
  window.addEventListener('pagehide', () => { stream?.close(); });
}
