const byId = id => document.getElementById(id);
const SESSION_KEY = 'lan-wzq-session';
const NAME_KEY = 'lan-player-name';
const BOARD_SIZE = 15;
const STONE_RADIUS = 0.42;
let state = null;
let sessionToken = null;
let eventSource = null;
let busy = false;
let connected = false;
let toastTimer = null;
let boardGeometry = null;
let resizeObserver = null;

function storageGet(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}
function storageSet(key, value) {
  try { if (value === null) { localStorage.removeItem(key); } else { localStorage.setItem(key, value); } }
  catch { /* Browser storage may be unavailable in private modes. */ }
}
function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}
function toast(message) {
  clearTimeout(toastTimer);
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  toastTimer = setTimeout(() => { byId('toast').hidden = true; }, 2600);
}
function setConnection(online, message) {
  byId('connection-dot').classList.toggle('offline', !online);
  byId('connection-label').textContent = message;
}
async function api(path, payload = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const response = await fetch(`/games/wzq/api/${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(sessionToken ? { Authorization: `Bearer ${sessionToken}` } : {}) },
      body: JSON.stringify(payload),
      signal: controller.signal
    });
    const result = await response.json();
    if (!response.ok) { throw Object.assign(new Error(result.error || '请重试。'), { status: response.status }); }
    return result;
  } catch (error) {
    if (error instanceof TypeError || error.name === 'AbortError') { throw new Error('连接中断，请重试。'); }
    throw error;
  } finally { clearTimeout(timer); }
}
async function withBusy(task) {
  if (busy) { return; }
  busy = true;
  updateActions();
  try { await task(); }
  catch (error) { toast(error.message); }
  finally { busy = false; updateActions(); }
}
function cleanName() {
  const name = byId('nickname').value.trim();
  if (!name || [...name].length > 16) { byId('nickname').focus(); throw new Error('昵称需为 1–16 个字符。'); }
  storageSet(NAME_KEY, name);
  return name;
}
function setTab(join) {
  byId('create-tab').classList.toggle('active', !join);
  byId('join-tab').classList.toggle('active', join);
  byId('create-tab').setAttribute('aria-selected', String(!join));
  byId('join-tab').setAttribute('aria-selected', String(join));
  byId('create-panel').hidden = join;
  byId('join-panel').hidden = !join;
}
function enterRoom(result) {
  eventSource?.close();
  sessionToken = result.token || sessionToken;
  storageSet(SESSION_KEY, sessionToken);
  applyState(result.state);
  setConnection(false, '连接中');
  eventSource = new EventSource(`/games/wzq/events?token=${encodeURIComponent(sessionToken)}`);
  eventSource.onopen = () => { connected = true; setConnection(true, '已连接'); updateActions(); };
  eventSource.onmessage = event => {
    connected = true;
    setConnection(true, '已连接');
    applyState(JSON.parse(event.data));
  };
  eventSource.onerror = () => {
    connected = false;
    setConnection(false, '重连中');
    updateActions();
    void api('resume').catch(error => {
      if (error.status === 401) { exitRoom(); toast('会话已过期，请重新加入。'); }
    });
  };
}
function applyState(next) {
  state = next;
  byId('lobby').hidden = true;
  byId('game').hidden = false;
  byId('room-number').textContent = state.code;
  renderPlayers();
  renderBoard();
  renderActions();
  renderHistory();
  updateActions();
}
function exitRoom() {
  eventSource?.close();
  eventSource = null;
  storageSet(SESSION_KEY, null);
  sessionToken = null;
  state = null;
  connected = false;
  byId('game').hidden = true;
  byId('lobby').hidden = false;
  setConnection(true, '局域网');
  history.replaceState(null, '', '/');
}
function prepareCanvas(canvas) {
  const bounds = canvas.getBoundingClientRect();
  const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
  const size = Math.floor(bounds.width * pixelRatio);
  if (canvas.width !== size || canvas.height !== size) { canvas.width = size; canvas.height = size; }
  const padding = size * 0.057;
  const spacing = (size - padding * 2) / (BOARD_SIZE - 1);
  return { size, padding, spacing, pixelRatio };
}
function drawStone(context, x, y, radius, color) {
  const gradient = context.createRadialGradient(x - radius * 0.31, y - radius * 0.35, radius * 0.04, x, y, radius * 1.13);
  if (color === 'black') {
    gradient.addColorStop(0, '#55575d');
    gradient.addColorStop(0.32, '#202125');
    gradient.addColorStop(1, '#070809');
  } else {
    gradient.addColorStop(0, '#fff');
    gradient.addColorStop(0.54, '#e3e3e2');
    gradient.addColorStop(1, '#aeb0b4');
  }
  context.beginPath();
  context.arc(x, y, radius, 0, Math.PI * 2);
  context.fillStyle = gradient;
  context.shadowColor = '#0009';
  context.shadowBlur = radius * 0.34;
  context.shadowOffsetX = radius * 0.1;
  context.shadowOffsetY = radius * 0.17;
  context.fill();
  context.shadowColor = 'transparent';
  context.shadowBlur = 0;
  context.shadowOffsetX = 0;
  context.shadowOffsetY = 0;
  context.lineWidth = Math.max(0.7, radius * 0.055);
  context.strokeStyle = color === 'black' ? '#777b83' : '#bcbfc3';
  context.stroke();
}
function renderGrid(canvas, board, lastMove, interactive) {
  const context = canvas.getContext('2d');
  const geometry = prepareCanvas(canvas);
  const { size, padding, spacing } = geometry;
  boardGeometry = canvas.id === 'board-canvas' ? geometry : boardGeometry;
  context.clearRect(0, 0, size, size);
  context.fillStyle = '#383936';
  context.fillRect(0, 0, size, size);
  for (let line = 0; line < BOARD_SIZE; line++) {
    const coordinate = padding + spacing * line;
    context.beginPath();
    context.moveTo(padding, coordinate);
    context.lineTo(size - padding, coordinate);
    context.moveTo(coordinate, padding);
    context.lineTo(coordinate, size - padding);
    context.lineWidth = line === 0 || line === BOARD_SIZE - 1 ? Math.max(1.2, size * 0.0018) : Math.max(0.75, size * 0.0011);
    context.strokeStyle = line === 0 || line === BOARD_SIZE - 1 ? '#6d6a5f' : '#66655d';
    context.stroke();
  }
  const starPoints = [3, 7, 11];
  for (const row of starPoints) {
    for (const column of starPoints) {
      const x = padding + spacing * column;
      const y = padding + spacing * row;
      context.beginPath();
      context.arc(x, y, Math.max(1.6, spacing * 0.065), 0, Math.PI * 2);
      context.fillStyle = '#69665b';
      context.fill();
    }
  }
  const stoneRadius = spacing * STONE_RADIUS;
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let column = 0; column < BOARD_SIZE; column++) {
      const color = board[row][column];
      if (!color) { continue; }
      const x = padding + spacing * column;
      const y = padding + spacing * row;
      drawStone(context, x, y, stoneRadius, color);
    }
  }
  if (lastMove) {
    const x = padding + spacing * lastMove.column;
    const y = padding + spacing * lastMove.row;
    context.beginPath();
    context.arc(x, y, Math.max(2, spacing * 0.105), 0, Math.PI * 2);
    context.fillStyle = lastMove.color === 'black' ? '#dce1eb' : '#263244';
    context.fill();
  }
  canvas.classList.toggle('locked', !interactive);
}
function renderBoard() {
  const interactive = Boolean(state && state.phase === 'playing' && state.turn === state.you && !state.undoRequest);
  const canvas = byId('board-canvas');
  renderGrid(canvas, state?.board || emptyBoard(), state?.lastMove, interactive);
  renderGrid(byId('preview-canvas'), previewBoard(), { row: 4, column: 5, color: 'white' }, false);
  byId('match-label').textContent = !state ? '等待中' : state.phase === 'waiting' ? '等待玩家加入' : state.phase === 'finished' ? state.winner === null ? '和棋' : '对局结束' : '进行中';
  byId('turn-label').textContent = !state ? '创建房间开始对局。' : state.phase === 'playing' ? state.turn === state.you ? '轮到你了' : `轮到 ${state.players[state.turn]?.name || '对手'} 落子` : state.phase === 'finished' ? state.winner === null ? '棋盘已满，和棋。' : state.winner === state.you ? '你赢了！' : `${state.players[state.winner]?.name || '对手'} 获胜。` : state.players.filter(Boolean).length < 2 ? '邀请一位好友加入。' : '双方准备后开始。';
  byId('move-label').textContent = `${state?.moves.length || 0} / 225`;
  const message = state?.phase === 'finished' ? state.winner === null ? '和棋' : state.winner === state.you ? '你赢了' : `${state.players[state.winner]?.name || '对手'} 获胜` : state?.undoRequest ? state.undoRequest.to === state.you ? '悔棋请求' : '等待悔棋回应' : '';
  byId('board-message').textContent = message;
  byId('board-message').hidden = !message;
}
function emptyBoard() { return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(null)); }
function previewBoard() {
  const board = emptyBoard();
  for (let column = 3; column <= 7; column++) { board[7][column] = 'black'; }
  board[6][5] = 'white';
  board[8][6] = 'white';
  return board;
}
function renderPlayers() {
  const list = byId('players');
  list.replaceChildren();
  for (let seat = 0; seat < 2; seat++) {
    const player = state.players[seat];
    const row = element('div', `player-row${player && state.phase === 'playing' && state.turn === seat ? ' active' : ''}`);
    const stone = element('span', `player-stone ${seat === 0 ? 'black' : player ? 'white' : 'empty'}`);
    const info = element('div');
    info.append(element('div', 'player-name', player?.name || '空位'));
    const status = !player ? '等待中' : !player.online ? '离线' : state.undoRequest?.from === seat ? '已请求悔棋' : state.undoRequest?.to === seat ? '请回应悔棋' : player.ready ? '准备' : state.phase === 'waiting' ? '未准备' : state.phase === 'finished' && state.rematchVotes.includes(seat) ? '已准备再来一局' : state.phase === 'finished' ? '已结束' : state.phase === 'playing' && state.turn === seat ? '轮到你了' : state.phase === 'playing' ? '进行中' : state.phase === 'finished' ? '已结束' : '已连接';
    info.append(element('div', `player-status${player?.online === false ? ' offline' : ''}`, status));
    row.append(stone, info);
    if (player) { row.append(element('span', 'player-score', String(player.score))); }
    list.append(row);
  }
}
function renderActions() {
  const bar = byId('actions');
  bar.replaceChildren();
  if (!state) { return; }
  const player = state.players[state.you];
  if (state.phase === 'waiting') {
    const ready = element('button', `button ${player.ready ? 'secondary' : 'primary'}`, player.ready ? '取消准备' : '准备');
    ready.type = 'button';
    ready.disabled = busy || !connected;
    ready.addEventListener('click', () => { void withBusy(async () => applyState((await api('ready', { ready: !player.ready })).state)); });
    bar.append(ready);
    if (state.host === state.you) {
      const start = element('button', 'button primary', '开始');
      start.type = 'button';
      start.disabled = busy || !connected || !state.players.every(entry => entry?.online && entry.ready);
      start.addEventListener('click', () => { void withBusy(async () => applyState((await api('start')).state)); });
      bar.append(start);
    }
    byId('action-note').textContent = state.players.filter(Boolean).length < 2 ? '还需一位玩家。' : state.players.every(entry => entry?.ready) ? '准备好就开始吧。' : '双方都需要准备。';
    return;
  }
  if (state.undoRequest) {
    if (state.undoRequest.to === state.you) {
      addAction(bar, '同意', 'primary', async () => applyState((await api('undo/respond', { accept: true })).state));
      addAction(bar, '拒绝', 'secondary', async () => applyState((await api('undo/respond', { accept: false })).state));
      byId('action-note').textContent = '对方申请撤回上一手。';
    } else {
      addAction(bar, '取消申请', 'secondary', async () => applyState((await api('undo/respond', { cancel: true })).state));
      byId('action-note').textContent = '等待对方回应。';
    }
    return;
  }
  if (state.phase === 'finished') {
    const ready = state.rematchVotes.includes(state.you);
    addAction(bar, ready ? '取消再来一局' : '再来一局', ready ? 'secondary' : 'primary', async () => applyState((await api('ready', { ready: !ready })).state));
    byId('action-note').textContent = state.rematchVotes.length ? '等待对方回应。' : '双方同意后开始。';
    return;
  }
  addAction(bar, '悔棋', 'secondary', async () => applyState((await api('undo/request')).state), state.moves.length === 0 || state.moves.at(-1).seat === state.you);
  byId('action-note').textContent = state.turn === state.you ? state.you === 0 ? '你执黑，请落子。' : '你执白，请落子。' : '等待对方落子。';
}
function addAction(container, label, style, action, disabled = false) {
  const button = element('button', `button ${style}`, label);
  button.type = 'button';
  button.disabled = busy || !connected || disabled;
  button.addEventListener('click', () => { void withBusy(action); });
  container.append(button);
}
function updateActions() {
  if (state) { renderActions(); }
  else {
    for (const id of ['create-button', 'join-button']) { byId(id).disabled = busy || !connected; }
  }
}
function renderHistory() {
  const list = byId('move-history');
  list.replaceChildren(...state.log.slice(-18).reverse().map(entry => element('li', '', entry.message)));
}
async function copyInvite() {
  const info = await fetch('/api/info').then(response => response.json());
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const base = local ? info.addresses[0] || location.origin : location.origin;
  const invite = `${base}/games/wzq/?room=${state.code}`;
  try {
    await navigator.clipboard.writeText(`${invite}\n房间号：${state.code}`);
    toast('邀请链接已复制。');
  } catch {
    toast(`${base} · ${state.code}`);
  }
}
function placeFromPointer(event) {
  if (!state || state.phase !== 'playing' || state.turn !== state.you || state.undoRequest || !connected || busy) { return; }
  const canvas = byId('board-canvas');
  const bounds = canvas.getBoundingClientRect();
  const localX = (event.clientX - bounds.left) * canvas.width / bounds.width;
  const localY = (event.clientY - bounds.top) * canvas.height / bounds.height;
  const { padding, spacing } = boardGeometry;
  const column = Math.round((localX - padding) / spacing);
  const row = Math.round((localY - padding) / spacing);
  if (row < 0 || row >= BOARD_SIZE || column < 0 || column >= BOARD_SIZE) { return; }
  const xDistance = Math.abs(localX - (padding + column * spacing));
  const yDistance = Math.abs(localY - (padding + row * spacing));
  if (xDistance > spacing * 0.46 || yDistance > spacing * 0.46) { return; }
  if (state.board[row][column] !== null) { toast('这里已有棋子。'); return; }
  void withBusy(async () => applyState((await api('move', { row, column })).state));
}
function setBusyButtons() {
  for (const id of ['create-button', 'join-button']) { byId(id).disabled = busy; }
}
function enterWithBusy(action) {
  void withBusy(async () => enterRoom(await action()));
}
byId('nickname').value = storageGet(NAME_KEY) || '';
byId('create-tab').addEventListener('click', () => setTab(false));
byId('join-tab').addEventListener('click', () => setTab(true));
byId('nickname').addEventListener('keydown', event => { if (event.key === 'Enter') { byId('join-panel').hidden ? byId('create-button').click() : byId('room-code').focus(); } });
byId('room-code').addEventListener('input', event => { event.target.value = event.target.value.replace(/[^0-9]/g, ''); });
byId('room-code').addEventListener('keydown', event => { if (event.key === 'Enter') { byId('join-button').click(); } });
byId('create-button').addEventListener('click', () => {
  if (busy) { return; }
  let name;
  try { name = cleanName(); } catch (error) { toast(error.message); return; }
  enterWithBusy(() => api('create', { name }));
});
byId('join-button').addEventListener('click', () => {
  if (busy) { return; }
  let name;
  try { name = cleanName(); } catch (error) { toast(error.message); return; }
  const code = byId('room-code').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('请输入六位房间号。'); return; }
  enterWithBusy(() => api('join', { name, code }));
});
byId('copy-room').addEventListener('click', () => { void copyInvite(); });
byId('board-canvas').addEventListener('pointerup', placeFromPointer);
byId('leave-button').addEventListener('click', () => byId('leave-dialog').showModal());
byId('cancel-leave').addEventListener('click', () => byId('leave-dialog').close());
byId('confirm-leave').addEventListener('click', () => {
  void withBusy(async () => { await api('leave'); byId('leave-dialog').close(); exitRoom(); });
});
window.addEventListener('resize', () => { if (!byId('game').hidden) { renderGrid(byId('board-canvas'), state.board, state.lastMove, state.phase === 'playing' && state.turn === state.you && !state.undoRequest); } });
if ('ResizeObserver' in window) {
  resizeObserver = new ResizeObserver(() => { if (!byId('game').hidden) { renderGrid(byId('board-canvas'), state.board, state.lastMove, state.phase === 'playing' && state.turn === state.you && !state.undoRequest); } });
  resizeObserver.observe(byId('board-canvas'));
}
async function initialize() {
  const room = new URLSearchParams(location.search).get('room');
  if (/^\d{6}$/.test(room || '')) { setTab(true); byId('room-code').value = room; }
  sessionToken = storageGet(SESSION_KEY);
  if (!sessionToken) { return; }
  void withBusy(async () => {
    try { enterRoom(await api('resume')); }
    catch (error) {
      sessionToken = null;
      if (error.status === 401) { storageSet(SESSION_KEY, null); }
      else { throw error; }
    }
  });
}
void initialize();

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !byId('game').hidden) { renderGrid(byId('board-canvas'), state.board, state.lastMove, state.phase === 'playing' && state.turn === state.you && !state.undoRequest); }
});
