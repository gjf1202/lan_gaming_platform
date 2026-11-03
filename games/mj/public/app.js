const SESSION_KEY = 'lan-mj-session';
const SUITS = { m: '萬', p: '筒', s: '條' };
const HONOR_NAMES = { w1: '東', w2: '南', w3: '西', w4: '北', d1: '中', d2: '發', d3: '白' };
const WINDS = ['东', '南', '西', '北'];
const ui = Object.fromEntries([
  'lobby', 'game', 'nickname', 'room-code', 'create-tab', 'join-tab', 'create-panel', 'join-panel',
  'create-button', 'join-button', 'room-number', 'copy-room', 'leave-button', 'wall-label',
  'seat-row', 'phase-label', 'turn-label', 'discard-grid', 'table-message', 'self-seat', 'hand-count',
  'melds', 'hand', 'actions', 'table-log', 'connection-dot', 'connection-label', 'toast', 'leave-dialog',
  'cancel-leave', 'confirm-leave'
].map((id) => [id.replace(/-([a-z])/g, (_, letter) => letter.toUpperCase()), document.getElementById(id)]));

let sessionToken = localStorage.getItem(SESSION_KEY);
let currentState = null;
let eventSource = null;
let toastTimer = 0;

const mahjongAlerts = (() => {
  const STORAGE_KEY = 'mj-alerts';
  const FLASH_INTERVAL_MS = 900;
  const originalTitle = document.title;
  const button = document.getElementById('alerts-toggle');
  let enabled = false;
  let latestState = null;
  let pendingKey = '';
  let titleTimer = null;
  let systemNotification = null;

  try {
    enabled = localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // Alerts still work for this page when storage is unavailable.
  }

  function updateButton() {
    button.textContent = enabled ? '提醒已开' : '提醒已关';
    button.setAttribute('aria-pressed', String(enabled));
    button.title = enabled ? '出牌及吃碰杠胡提醒已开启' : '出牌及吃碰杠胡提醒已关闭';
  }

  function clearDisplay() {
    clearInterval(titleTimer);
    titleTimer = null;
    document.title = originalTitle;
    if (systemNotification) {
      systemNotification.close();
      systemNotification = null;
    }
  }

  function getPendingAlert(state) {
    if (!state || !state.players[state.you]) {
      return null;
    }
    const discardCount = state.players.reduce((total, player) => total + (player?.discards.length || 0), 0);
    const handKey = `${state.code}/${state.you}/${state.dealer}/${state.wallCount}/${discardCount}`;
    if (state.phase === 'playing' && state.turn === state.you) {
      return { key: `${handKey}/turn/${state.hand.join(',')}`, message: '轮到你了。' };
    }
    if (state.phase === 'claim' && state.claimOptions.length > 0 && !state.claimResponses[state.you]) {
      return {
        key: `${handKey}/claim/${state.lastDiscard?.seat}/${state.lastDiscard?.tile}/${state.claimOptions.join(',')}`,
        message: state.claimOptions.includes('hu') ? '可以胡牌。' : '可以吃碰杠。'
      };
    }
    return null;
  }

  function showSystemNotification(message) {
    if (!window.isSecureContext || !('Notification' in window) || Notification.permission !== 'granted') {
      return;
    }
    try {
      systemNotification = new Notification(`麻将 · ${message}`, {
        body: `房间 ${latestState.code}`,
        tag: `mj-${latestState.code}`
      });
      systemNotification.onclick = () => {
        window.focus();
        clearDisplay();
      };
    } catch (error) {
      console.warn('System notification unavailable:', error.name);
    }
  }

  function refresh(force = false) {
    const alert = enabled ? getPendingAlert(latestState) : null;
    if (!alert) {
      pendingKey = '';
      clearDisplay();
      return;
    }
    if (!force && pendingKey === alert.key) {
      return;
    }
    pendingKey = alert.key;
    clearDisplay();
    if (document.visibilityState === 'visible') {
      showToast(alert.message);
      return;
    }
    const alertTitle = `${alert.message} · ${originalTitle}`;
    document.title = alertTitle;
    titleTimer = setInterval(() => {
      document.title = document.title === originalTitle ? alertTitle : originalTitle;
    }, FLASH_INTERVAL_MS);
    showSystemNotification(alert.message);
  }

  async function toggleAlerts() {
    enabled = !enabled;
    try {
      localStorage.setItem(STORAGE_KEY, String(enabled));
    } catch {
      // Persistence is optional; the switch remains usable.
    }
    updateButton();
    if (!enabled) {
      refresh();
      showToast('提醒已关闭。');
      return;
    }
    // Request permission only in response to the Alerts button, on secure origins.
    if (window.isSecureContext && 'Notification' in window && Notification.permission === 'default') {
      try {
        await Notification.requestPermission();
      } catch (error) {
        console.warn('Notification permission unavailable:', error.name);
      }
    }
    if (!enabled) {
      return;
    }
    const systemAllowed = window.isSecureContext && 'Notification' in window && Notification.permission === 'granted';
    showToast(systemAllowed ? '提醒已开启。' : '页签提醒已开启。');
    refresh(true);
  }

  button.addEventListener('click', () => { void toggleAlerts(); });
  document.addEventListener('visibilitychange', () => { refresh(true); });
  window.addEventListener('pagehide', clearDisplay);
  updateButton();

  return {
    updateState(state) {
      latestState = state;
      refresh();
    }
  };
})();


function tileParts(tile) {
  if (HONOR_NAMES[tile]) {
    return { main: HONOR_NAMES[tile], sub: '', red: tile === 'd1' };
  }
  return { main: tile.slice(1), sub: SUITS[tile[0]], red: false };
}

function makeTileElement(tile, className = 'discard-tile') {
  const tileElement = document.createElement('span');
  const parts = tileParts(tile);
  tileElement.className = `${className}${parts.red ? ' red' : ''}`;
  tileElement.setAttribute('aria-label', `${parts.main}${parts.sub}`);
  tileElement.textContent = `${parts.main}${parts.sub}`;
  return tileElement;
}

async function api(path, body = {}) {
  const response = await fetch(`/games/mj/api/${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(sessionToken ? { authorization: `Bearer ${sessionToken}` } : {}) },
    body: JSON.stringify(body)
  });
  const result = await response.json();
  if (!response.ok) {
    throw new Error(result.error || '请求失败，请重试。');
  }
  if (result.token) {
    sessionToken = result.token;
    localStorage.setItem(SESSION_KEY, sessionToken);
    connectEvents();
  }
  if (result.state) {
    setState(result.state);
  }
  return result;
}

function setState(state) {
  currentState = state;
  mahjongAlerts.updateState(state);
  ui.lobby.hidden = true;
  ui.game.hidden = false;
  render();
}

function connectEvents() {
  eventSource?.close();
  eventSource = new EventSource(`/games/mj/events?token=${encodeURIComponent(sessionToken)}`);
  eventSource.onopen = () => {
    ui.connectionDot.parentElement.classList.remove('offline');
    ui.connectionLabel.textContent = '在线';
  };
  eventSource.onmessage = (event) => {
    setState(JSON.parse(event.data));
  };
  eventSource.onerror = () => {
    mahjongAlerts.updateState(null);
    ui.connectionDot.parentElement.classList.add('offline');
    ui.connectionLabel.textContent = '重连中';
  };
}

function showToast(message) {
  ui.toast.textContent = message;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, 2500);
}

async function runAction(path, body = {}) {
  try {
    await api(path, body);
  } catch (error) {
    showToast(error.message);
  }
}

function render() {
  const state = currentState;
  ui.roomNumber.textContent = state.code;
  ui.wallLabel.textContent = `牌墙 ${state.wallCount}`;
  ui.phaseLabel.textContent = ({ waiting: '等待中', playing: '进行中', claim: '等待响应', finished: '本局结束' })[state.phase];
  ui.selfSeat.textContent = `${WINDS[(state.you - state.dealer + 4) % 4]} · ${state.you + 1}号位`;
  renderSeats(state);
  renderDiscards(state);
  renderHand(state);
  renderMelds(state);
  renderActions(state);
  renderLog(state);
}

function renderSeats(state) {
  ui.seatRow.replaceChildren();
  state.players.forEach((player, seat) => {
    const seatElement = document.createElement('div');
    const wind = WINDS[(seat - state.dealer + 4) % 4];
    seatElement.className = `seat${state.phase !== 'waiting' && seat === state.turn ? ' active' : ''}${player && !player.online ? ' offline' : ''}`;
    const number = document.createElement('span');
    number.className = 'seat-number';
    number.textContent = String(seat + 1);
    const name = document.createElement('span');
    name.className = 'seat-name';
    name.textContent = player ? player.name : '空位';
    const meta = document.createElement('span');
    meta.className = 'seat-meta';
    const windLabel = document.createElement('span');
    windLabel.className = seat === state.dealer ? 'dealer' : '';
    windLabel.textContent = seat === state.dealer ? `${wind} · 庄家` : wind;
    meta.append(windLabel);
    if (player && state.phase !== 'waiting') {
      const count = document.createElement('span');
      count.className = 'tile-count';
      count.textContent = `${player.handCount} 张`;
      meta.append(count);
    } else if (player) {
      const ready = document.createElement('span');
      ready.textContent = player.ready ? '已准备' : player.online ? '在线' : '离线';
      meta.append(ready);
    }
    seatElement.append(number, name, meta);
    if (player?.melds.length) {
      const exposed = document.createElement('span');
      exposed.className = 'seat-melds';
      for (const meld of player.melds) {
        for (const tile of meld.tiles) {
          exposed.append(makeTileElement(tile, 'meld-tile'));
        }
      }
      seatElement.append(exposed);
    }
    ui.seatRow.append(seatElement);
  });
}

function renderDiscards(state) {
  ui.discardGrid.replaceChildren();
  for (const player of state.players) {
    if (!player) {
      continue;
    }
    for (const discard of player.discards) {
      const tile = makeTileElement(discard.tile);
      if (discard.claimed) {
        tile.classList.add('claimed');
      }
      ui.discardGrid.append(tile);
    }
  }
  if (state.phase === 'claim' && state.lastDiscard) {
    ui.tableMessage.textContent = `${state.players[state.lastDiscard.seat].name} 打出 ${tileParts(state.lastDiscard.tile).main}${tileParts(state.lastDiscard.tile).sub}。`;
  } else if (state.phase === 'finished') {
    ui.tableMessage.textContent = state.winner === null ? '流局。' : `${state.players[state.winner].name} 胡牌。`;
  } else if (state.phase === 'waiting') {
    ui.tableMessage.textContent = `请准备 · ${state.players.filter(Boolean).length}/4 人已入座`;
  } else {
    ui.tableMessage.textContent = state.turn === state.you ? '已摸牌，请出牌' : `等待 ${state.players[state.turn]?.name || '玩家'} 出牌。`;
  }
  ui.turnLabel.textContent = state.phase === 'playing' ? `${state.players[state.turn]?.name || '玩家'} · ${WINDS[(state.turn - state.dealer + 4) % 4]}` : '';
}

function renderHand(state) {
  ui.hand.replaceChildren();
  ui.handCount.textContent = String(state.hand.length);
  const canDiscard = state.phase === 'playing' && state.turn === state.you;
  state.hand.forEach((tile, index) => {
    const button = document.createElement('button');
    const parts = tileParts(tile);
    button.type = 'button';
    button.className = `hand-tile${parts.red ? ' red' : ''}${index > 0 && state.hand[index - 1][0] !== tile[0] ? ' gap' : ''}`;
    button.setAttribute('aria-label', `打出 ${parts.main}${parts.sub}`);
    button.disabled = !canDiscard;
    const main = document.createElement('span');
    main.textContent = parts.main;
    button.append(main);
    if (parts.sub) {
      const suit = document.createElement('small');
      suit.textContent = parts.sub;
      button.append(suit);
    }
    button.addEventListener('click', () => runAction('discard', { tile }));
    ui.hand.append(button);
  });
}

function renderMelds(state) {
  ui.melds.replaceChildren();
  for (const meld of state.players[state.you]?.melds || []) {
    const meldElement = document.createElement('div');
    meldElement.className = 'meld';
    for (const tile of meld.tiles) {
      meldElement.append(makeTileElement(tile, 'meld-tile'));
    }
    const label = document.createElement('span');
    label.className = 'meld-label';
    label.textContent = meld.type === 'kong' && !meld.open ? '暗杠' : ({ chi: '吃', pung: '碰', kong: '杠' })[meld.type] || '副露';
    meldElement.append(label);
    ui.melds.append(meldElement);
  }
}

function addAction(label, action, options = {}) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = `button${options.primary ? ' primary' : ' secondary'}`;
  button.textContent = label;
  button.addEventListener('click', action);
  ui.actions.append(button);
}

function renderActions(state) {
  ui.actions.replaceChildren();
  if (state.phase === 'waiting') {
    const player = state.players[state.you];
    addAction(player.ready ? '未准备' : '准备', () => runAction('ready', { ready: !player.ready }), { primary: !player.ready });
    const allReady = state.players.length === 4 && state.players.every((entry) => entry?.ready && entry.online);
    if (state.host === state.you) {
      addAction('开始', () => runAction('start'), { primary: true });
      ui.actions.lastElementChild.disabled = !allReady;
    }
    return;
  }
  if (state.phase === 'finished') {
    const player = state.players[state.you];
    addAction(player.ready ? '准备' : '下一局', () => runAction('ready', { ready: !player.ready }), { primary: !player.ready });
    return;
  }
  if (state.phase === 'claim') {
    if (state.claimOptions.length === 0) {
      const pending = state.claimResponses.some((responded, seat) => seat !== state.you && !responded);
      ui.tableMessage.textContent += pending ? ' · 等待吃碰杠胡回应' : '';
      return;
    }
    if (state.claimOptions.includes('hu')) {
      addAction('胡', () => runAction('claim', { type: 'hu' }), { primary: true });
    }
    if (state.claimOptions.includes('kong')) {
      addAction('杠', () => runAction('claim', { type: 'kong' }), { primary: true });
    }
    if (state.claimOptions.includes('pung')) {
      addAction('碰', () => runAction('claim', { type: 'pung' }));
    }
    for (const option of state.claimOptions.filter((entry) => entry.startsWith('chi:'))) {
      const tiles = option.slice(4).split(',');
      addAction(`吃 · ${tiles.map((tile) => tileParts(tile).main + tileParts(tile).sub).join(' ')}`, () => runAction('claim', { type: 'chi', tiles }));
    }
    addAction('过', () => runAction('claim', { type: 'pass' }));
    return;
  }
  if (state.phase === 'playing' && state.turn === state.you) {
    if (state.selfOptions.hu) {
      addAction('胡', () => runAction('hu'), { primary: true });
    }
    for (const tile of state.selfOptions.kong) {
      const label = tile.startsWith('upgrade:') ? '补杠' : `杠 · ${tileParts(tile).main}${tileParts(tile).sub}`;
      addAction(label, () => runAction('kong', { tile }));
    }
    if (!state.selfOptions.hu && state.selfOptions.kong.length === 0) {
      ui.actions.textContent = '点击手牌出牌。';
      ui.actions.classList.add('action-note');
    }
  }
}

function renderLog(state) {
  ui.tableLog.replaceChildren();
  for (const entry of state.log.slice(-5)) {
    const log = document.createElement('span');
    log.className = 'log-entry';
    log.textContent = entry.message;
    ui.tableLog.append(log);
  }
}

function selectEntry(mode) {
  const createMode = mode === 'create';
  ui.createTab.classList.toggle('active', createMode);
  ui.createTab.setAttribute('aria-selected', String(createMode));
  ui.joinTab.classList.toggle('active', !createMode);
  ui.joinTab.setAttribute('aria-selected', String(!createMode));
  ui.createPanel.hidden = !createMode;
  ui.joinPanel.hidden = createMode;
}

ui.createTab.addEventListener('click', () => selectEntry('create'));
ui.joinTab.addEventListener('click', () => selectEntry('join'));
ui.createButton.addEventListener('click', () => api('create', { name: ui.nickname.value }).catch((error) => showToast(error.message)));
ui.joinButton.addEventListener('click', () => api('join', { name: ui.nickname.value, code: ui.roomCode.value.trim() }).catch((error) => showToast(error.message)));
ui.roomCode.addEventListener('input', () => { ui.roomCode.value = ui.roomCode.value.replace(/\D/g, '').slice(0, 6); });
ui.copyRoom.addEventListener('click', async () => {
  try {
    const info = await fetch('/api/info').then((response) => response.json());
    const local = ['localhost', '127.0.0.1', '[::1]'].includes(location.hostname);
    const address = local ? info.addresses[0] || location.origin : location.origin;
    const invite = `${address}/games/mj/?room=${currentState.code}`;
    try {
      await navigator.clipboard.writeText(invite);
      showToast('邀请链接已复制。');
    } catch {
      showToast(invite);
    }
  } catch (error) {
    showToast('连接中断，请重试。');
  }
});
ui.leaveButton.addEventListener('click', () => ui.leaveDialog.showModal());
ui.cancelLeave.addEventListener('click', () => ui.leaveDialog.close());
ui.confirmLeave.addEventListener('click', async () => {
  try {
    await api('leave');
    mahjongAlerts.updateState(null);
    eventSource?.close();
    localStorage.removeItem(SESSION_KEY);
    location.reload();
  } catch (error) { showToast(error.message); }
});

if (sessionToken) {
  api('resume').then(connectEvents).catch(() => {
    localStorage.removeItem(SESSION_KEY);
    sessionToken = null;
  });
}

const invitedRoom = new URLSearchParams(location.search).get('room');
if (/^\d{6}$/.test(invitedRoom || '')) { selectEntry('join'); ui.roomCode.value = invitedRoom; }
