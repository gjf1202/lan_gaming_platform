const byId = (id) => document.getElementById(id);
const NAME_KEY = 'lan-player-name';
const POLL_INTERVAL_MS = 3000;
const TOAST_DURATION_MS = 3500;
const GAME_NAMES = { ddz: '斗地主', wzq: '五子棋', mj: '麻将' };
const activeRooms = new Map();
let lobby = { rooms: [], addresses: [] };
let filter = 'all';
let busy = false;
let online = false;
let polling = false;
let toastTimer;
let roomSignature = '';

function readStorage(key) {
  try { return localStorage.getItem(key); }
  catch { return null; }
}

function sessionKey(game) { return `lan-${game}-session`; }

function toast(message) {
  byId('toast').textContent = message;
  byId('toast').hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { byId('toast').hidden = true; }, TOAST_DURATION_MS);
}

function element(tag, className = '', text = '') {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(10000), ...options });
  const result = await response.json();
  if (!response.ok) { throw Object.assign(new Error(result.error || '请求失败，请重试。'), { status: response.status }); }
  return result;
}

async function gameApi(game, action, body = {}, token = '') {
  return requestJson(`/games/${game}/api/${action}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body)
  });
}

function playerName() {
  const name = byId('player-name').value.trim();
  if (!name || [...name].length > 12 || /[\x00-\x1f\x7f]/.test(name)) {
    byId('player-name').focus();
    throw new Error('昵称需为 1–12 个字符。');
  }
  // A full-page game navigation needs storage to carry its session safely.
  try { localStorage.setItem(NAME_KEY, name); }
  catch { throw new Error('请允许浏览器存储后加入。'); }
  return name;
}

function setBusy(value) {
  busy = value;
  for (const button of document.querySelectorAll('main button, #create-dialog button')) {
    button.disabled = value || button.dataset.unavailable === 'true';
  }
}

async function runAction(action) {
  if (busy) { return; }
  setBusy(true);
  try { await action(); }
  catch (error) { toast(error.name === 'TypeError' || error.name === 'TimeoutError' ? '连接中断，请重试。' : error.message); }
  finally { setBusy(false); }
}

async function resumeRoom(game) {
  const token = readStorage(sessionKey(game));
  if (!token) { return null; }
  try {
    const { state } = await gameApi(game, 'resume', {}, token);
    activeRooms.set(game, state.code);
    return { token, code: state.code };
  } catch (error) {
    if (error.status !== 401) { throw error; }
    localStorage.removeItem(sessionKey(game));
    activeRooms.delete(game);
    return null;
  }
}

async function confirmSwitch() {
  const dialog = byId('switch-dialog');
  dialog.returnValue = '';
  dialog.showModal();
  return new Promise((resolve) => {
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'leave'); }, { once: true });
  });
}

async function enterRoom(game, code = '') {
  const name = playerName();
  const current = await resumeRoom(game);
  if (current?.code === code) { location.assign(`/games/${game}/`); return; }
  if (current) {
    if (!await confirmSwitch()) { return; }
    await gameApi(game, 'leave', {}, current.token);
    localStorage.removeItem(sessionKey(game));
    activeRooms.delete(game);
  }
  const result = await gameApi(game, code ? 'join' : 'create', { name, ...(code ? { code } : {}) });
  try { localStorage.setItem(sessionKey(game), result.token); }
  catch {
    await gameApi(game, 'leave', {}, result.token);
    throw new Error('请允许浏览器存储后加入。');
  }
  location.assign(`/games/${game}/`);
}

function openCreate(game = 'ddz') {
  if (busy) { return; }
  byId('create-game').value = game;
  byId('create-dialog').showModal();
}

function renderRooms(force = false) {
  const openOnly = byId('open-only').checked;
  const rooms = lobby.rooms.filter((room) => (filter === 'all' || room.game === filter) && (!openOnly || room.joinable));
  const signature = JSON.stringify([rooms, [...activeRooms], online, openOnly, filter]);
  if (!force && roomSignature === signature) { return; }
  roomSignature = signature;
  byId('table-count').textContent = String(rooms.length);
  const list = byId('room-list');
  list.replaceChildren();
  for (const room of rooms) {
    const row = element('tr');
    for (const value of [`#${room.code}`, GAME_NAMES[room.game], room.host, `${room.players} / ${room.capacity}`]) {
      row.append(element('td', '', value));
    }
    const statusCell = element('td');
    const status = room.joinable ? '可加入' : room.players >= room.capacity && room.phase === 'waiting' ? '已满员' : room.phase === 'finished' ? '已结束' : '进行中';
    statusCell.append(element('span', `status-label${room.joinable ? '' : ' busy'}`, status));
    const actionCell = element('td');
    const ownRoom = activeRooms.get(room.game) === room.code;
    const button = element('button', 'button small', ownRoom ? '继续 →' : '加入 →');
    button.type = 'button';
    button.dataset.unavailable = String(!online || (!room.joinable && !ownRoom));
    button.disabled = busy || button.dataset.unavailable === 'true';
    button.addEventListener('click', () => {
      if (ownRoom) { location.assign(`/games/${room.game}/`); }
      else { void runAction(() => enterRoom(room.game, room.code)); }
    });
    actionCell.append(button);
    row.append(statusCell, actionCell);
    list.append(row);
  }
  const empty = byId('empty-state');
  empty.hidden = rooms.length > 0;
  empty.querySelector('strong').textContent = !online ? '大厅暂时无法连接' : lobby.rooms.length ? '没有符合条件的房间' : '暂无房间';
  empty.querySelector('p').textContent = !online ? '请检查主机，正在尝试重连。' : '创建房间，邀请好友一起玩。';
  byId('empty-create').hidden = !online;
}

function renderLobby() {
  byId('room-count').textContent = online ? String(lobby.rooms.length) : '—';
  byId('player-count').textContent = online ? String(lobby.rooms.reduce((count, room) => count + room.online, 0)) : '—';
  for (const game of Object.keys(GAME_NAMES)) {
    const count = lobby.rooms.filter((room) => room.game === game).length;
    byId(`${game}-count`).textContent = !online ? '暂不可用' : count ? `${count} 个房间` : '暂无房间';
    byId(`${game}-continue`).hidden = !activeRooms.has(game);
  }
  const status = byId('server-status');
  status.classList.toggle('offline', !online);
  status.replaceChildren(element('i', 'live-dot'), document.createTextNode(online ? '已连接' : '离线'));
  byId('network-error').hidden = online;
  renderRooms();
}

async function refreshLobby() {
  if (polling) { return; }
  polling = true;
  try { lobby = await requestJson('/api/lobby'); online = true; }
  catch { online = false; }
  finally { polling = false; renderLobby(); }
}

byId('player-name').value = readStorage(NAME_KEY) || '';
byId('player-name').addEventListener('input', () => {
  try { localStorage.setItem(NAME_KEY, byId('player-name').value); }
  catch { /* Joining reports an actionable message if persistence is blocked. */ }
});
for (const button of document.querySelectorAll('[data-create]')) {
  button.addEventListener('click', () => { void runAction(() => enterRoom(button.dataset.create)); });
}
for (const button of document.querySelectorAll('[data-filter]')) {
  button.addEventListener('click', () => {
    filter = button.dataset.filter;
    for (const item of document.querySelectorAll('[data-filter]')) {
      const selected = item === button;
      item.classList.toggle('active', selected);
      item.setAttribute('aria-pressed', String(selected));
    }
    renderRooms();
  });
}
byId('open-only').addEventListener('change', () => { renderRooms(); });
byId('create-room').addEventListener('click', () => { openCreate(); });
byId('empty-create').addEventListener('click', () => { openCreate(filter === 'all' ? 'ddz' : filter); });
byId('cancel-create').addEventListener('click', () => { byId('create-dialog').close(); });
byId('cancel-switch').addEventListener('click', () => { byId('switch-dialog').close('cancel'); });
byId('confirm-switch').addEventListener('click', () => { byId('switch-dialog').close('leave'); });
byId('create-form').addEventListener('submit', (event) => {
  event.preventDefault();
  byId('create-dialog').close();
  void runAction(() => enterRoom(byId('create-game').value));
});
byId('quick-join').addEventListener('submit', (event) => {
  event.preventDefault();
  const code = byId('join-code').value.trim();
  if (!/^\d{6}$/.test(code)) { toast('请输入六位房间号。'); return; }
  void runAction(() => enterRoom(byId('join-game').value, code));
});
byId('join-code').addEventListener('input', () => {
  byId('join-code').setCustomValidity('');
  byId('join-code').value = byId('join-code').value.replace(/\D/g, '').slice(0, 6);
});
byId('join-code').addEventListener('invalid', () => { byId('join-code').setCustomValidity('请输入六位房间号。'); });
byId('refresh').addEventListener('click', () => { void refreshLobby(); });
byId('copy-lobby').addEventListener('click', () => {
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
  const address = local ? lobby.addresses[0] || location.origin : location.origin;
  void navigator.clipboard?.writeText(address).then(() => { toast('大厅链接已复制。'); }).catch(() => { toast(address); });
  if (!navigator.clipboard?.writeText) { toast(address); }
});
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') { void refreshLobby(); } });
window.addEventListener('pageshow', (event) => { if (event.persisted) { location.reload(); } });

async function initialize() {
  await Promise.allSettled(Object.keys(GAME_NAMES).map(async (game) => { await resumeRoom(game); }));
  await refreshLobby();
  setInterval(() => { if (document.visibilityState === 'visible') { void refreshLobby(); } }, POLL_INTERVAL_MS);
}
void initialize();
