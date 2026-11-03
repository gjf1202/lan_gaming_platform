import { definition as snake } from './snake.js';
import { definition as tetris } from './tetris.js';
import { definition as tank } from './tank.js';
import { definition as sokoban } from './sokoban.js';

const DEFINITIONS = { snake, tetris, tank, sokoban };
const REPEAT_DELAY = .19;
const REPEAT_INTERVAL = .08;
const byId = (id) => document.getElementById(id);
const definition = DEFINITIONS[location.pathname.split('/')[2]] || snake;
const canvas = byId('board');
const context = canvas.getContext('2d');
const held = new Map();
const pressedCodes = new Set();
const extraButtons = new Map();
let option = definition.defaultOption;
let game;
let phase = 'idle';
let lastFrame = 0;
let uiSignature = '';
let bestRecord = null;
let frameId;
let pendingOption = null;

function element(tag, text, className = '') {
  const node = document.createElement(tag);
  node.textContent = text;
  node.className = className;
  return node;
}

function readRecord() {
  try {
    const value = JSON.parse(localStorage.getItem(`lan-arcade-${definition.id}-${definition.lowerBest ? option : 'best'}`) || 'null');
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
  }
  catch { return null; }
}

function recordResult() {
  if (definition.lowerBest && !game.won) { return; }
  const previous = bestRecord;
  const score = game.stats().score;
  const improved = previous === null || (definition.lowerBest ? score < previous : score > previous);
  if (!improved) { return; }
  bestRecord = score;
  try { localStorage.setItem(`lan-arcade-${definition.id}-${definition.lowerBest ? option : 'best'}`, JSON.stringify(score)); }
  catch { document.querySelector('.save-note').textContent = '浏览器存储不可用，记录仅保留到页面关闭'; }
}

function releaseControls() {
  for (const action of held.keys()) { game.input(action, false); }
  held.clear();
  pressedCodes.clear();
}

function refreshUi() {
  const stats = game.stats();
  if (!definition.lowerBest || game.won) { recordResult(); }
  const best = bestRecord;
  const signature = JSON.stringify([phase, stats, best, option]);
  if (signature === uiSignature) { return; }
  uiSignature = signature;
  byId('score').textContent = stats.score;
  byId('best').textContent = best ?? (definition.lowerBest ? '—' : 0);
  byId('board-detail').textContent = stats.detail || '';
  byId('board-status').textContent = ({ idle: '准备开始', running: definition.id === 'sokoban' ? '慢慢想，不着急' : '进行中', paused: '已暂停', finished: game.won ? '已通关' : '本局结束' })[phase];
  byId('metrics').replaceChildren(...stats.metrics.flatMap(([label, value]) => [element('dt', label), element('dd', String(value))]));
  byId('game-message').textContent = stats.message;
  byId('pause').disabled = !['running', 'paused'].includes(phase);
  byId('pause').textContent = phase === 'paused' ? '继续' : '暂停';
  byId('start').textContent = phase === 'idle' ? '开始游戏' : '重新开始';
  byId('overlay').hidden = phase === 'running';
  byId('overlay-title').textContent = phase === 'idle' ? '准备好了吗？' : phase === 'paused' ? '休息一下' : game.won ? '完成啦！' : '本局结束';
  byId('overlay-message').textContent = phase === 'idle' ? '点击开始，轻松玩一局。' : phase === 'paused' ? '进度已保留，准备好就继续。' : stats.message;
  const next = definition.id === 'sokoban' && game.won && Number(option) < definition.options.length - 1;
  byId('overlay-start').textContent = phase === 'paused' ? '继续游戏' : next ? '下一关' : phase === 'finished' ? '再来一局' : '开始游戏';
  if (extraButtons.has('undo')) { extraButtons.get('undo').disabled = !game.history?.length || phase === 'paused'; }
  if (extraButtons.has('next')) { extraButtons.get('next').disabled = !game.won || Number(option) >= definition.options.length - 1; }
}

function resetGame(nextOption = option, start = true) {
  if (game) { releaseControls(); }
  option = nextOption;
  byId('game-option').value = option;
  game = definition.create(option);
  bestRecord = readRecord();
  phase = start ? 'running' : 'idle';
  lastFrame = 0;
  refreshUi();
  game.render(context);
  updateSecondPlayer();
  if (start) { canvas.focus({ preventScroll: true }); }
}

function setPaused(paused) {
  if (!['running', 'paused'].includes(phase)) { return; }
  releaseControls();
  phase = paused ? 'paused' : 'running';
  lastFrame = 0;
  refreshUi();
  if (!paused) { canvas.focus({ preventScroll: true }); }
}

function nextLevel() {
  if (definition.id !== 'sokoban' || !game.won || Number(option) >= definition.options.length - 1) { return; }
  resetGame(String(Number(option) + 1));
}

function act(action, pressed = true) {
  if (action === 'next') { if (pressed) { nextLevel(); } return; }
  if (action === 'undo' && pressed && ['running', 'finished'].includes(phase)) {
    game.input(action, true);
    if (!game.over) { phase = 'running'; }
    refreshUi();
    game.render(context);
    return;
  }
  if (phase !== 'running') { return; }
  game.input(action, pressed);
  if (pressed) { held.set(action, REPEAT_DELAY); }
  else { held.delete(action); }
}

function requestRestart(nextOption = option) {
  if (phase !== 'running' && phase !== 'paused') { resetGame(nextOption); return; }
  setPaused(true);
  pendingOption = nextOption;
  byId('restart-dialog').showModal();
}

function setupControls() {
  const groups = definition.id === 'tank' ? [['', '一号'], ['p2-', '二号']] : [['', '']];
  for (const [prefix, label] of groups) {
    const group = element('div', '', 'control-group');
    if (prefix) { group.dataset.secondPlayer = 'true'; }
    if (label) { group.append(element('span', label, 'control-label')); }
    for (const [action, text] of definition.controls) {
      const button = element('button', text, 'button');
      button.type = 'button';
      button.setAttribute('aria-label', `${label}${({ up: '向上', down: '向下', left: '向左', right: '向右' })[action] || text}`);
      const control = prefix + action;
      button.addEventListener('pointerdown', (event) => { event.preventDefault(); button.setPointerCapture(event.pointerId); act(control); });
      for (const eventName of ['pointerup', 'pointercancel', 'lostpointercapture']) {
        button.addEventListener(eventName, () => { act(control, false); });
      }
      button.addEventListener('click', (event) => { if (event.detail === 0) { act(control); act(control, false); } });
      group.append(button);
    }
    byId('touch-controls').append(group);
  }
  for (const [action, label] of definition.extras || []) {
    const button = element('button', label, 'button');
    button.type = 'button';
    button.addEventListener('click', () => { act(action); });
    extraButtons.set(action, button);
    byId('extra-actions').append(button);
  }
}

function updateSecondPlayer() {
  const group = document.querySelector('[data-second-player]');
  if (group) { group.hidden = option !== 'duo'; }
}

function frame(timestamp) {
  const delta = lastFrame ? Math.min((timestamp - lastFrame) / 1000, .1) : 0;
  lastFrame = timestamp;
  if (phase === 'running') {
    for (const [action, remaining] of held) {
      if (!definition.repeatActions?.includes(action)) { continue; }
      const next = remaining - delta;
      if (next <= 0) { game.input(action, true); held.set(action, REPEAT_INTERVAL); }
      else { held.set(action, next); }
    }
    game.update(delta);
    if (game.over) { phase = 'finished'; releaseControls(); }
    refreshUi();
    game.render(context);
  }
  frameId = requestAnimationFrame(frame);
}

document.title = `游戏厅 · ${definition.title}`;
canvas.width = definition.width;
canvas.height = definition.height;
canvas.setAttribute('aria-label', `${definition.title}游戏画面，请使用键盘或下方按钮操作`);
byId('game-title').textContent = definition.title;
byId('game-description').textContent = definition.description;
byId('mode-label').textContent = definition.mode;
byId('rules').textContent = definition.rules;
byId('game-note').textContent = definition.note || '单人游戏不需要建房，其他人可在自己的浏览器独立游玩。';
byId('score-label').textContent = definition.scoreLabel || '得分';
byId('best-label').textContent = definition.bestLabel || '最佳';
byId('option-label').textContent = definition.optionLabel;
byId('game-option').replaceChildren(...definition.options.map(([value, label]) => {
  const node = element('option', label);
  node.value = value;
  return node;
}));
byId('keyboard-help').replaceChildren(...definition.help.flatMap(([keys, description]) => [element('dt', keys), element('dd', description)]));
document.querySelector(`nav a[href="/games/${definition.id}/"]`)?.setAttribute('aria-current', 'page');
setupControls();
resetGame(option, false);
byId('start').addEventListener('click', () => { requestRestart(); });
byId('pause').addEventListener('click', () => { setPaused(phase !== 'paused'); });
byId('overlay-start').addEventListener('click', () => {
  if (phase === 'paused') { setPaused(false); }
  else if (definition.id === 'sokoban' && game.won && Number(option) < definition.options.length - 1) { nextLevel(); }
  else { resetGame(); }
});
byId('game-option').addEventListener('change', () => { const value = byId('game-option').value; byId('game-option').value = option; requestRestart(value); });
byId('cancel-restart').addEventListener('click', () => { byId('restart-dialog').close(); setPaused(false); });
byId('confirm-restart').addEventListener('click', () => { byId('restart-dialog').close(); resetGame(pendingOption || option); });
byId('restart-dialog').addEventListener('cancel', () => { setPaused(false); });
document.addEventListener('keydown', (event) => {
  if (event.target instanceof HTMLSelectElement || event.target instanceof HTMLInputElement || byId('restart-dialog').open) { return; }
  const pauseKey = ['KeyP', 'Escape'].includes(event.code) || event.code === 'Space' && !definition.keys.Space;
  if (pauseKey) { event.preventDefault(); if (!event.repeat) { setPaused(phase !== 'paused'); } return; }
  const action = definition.keys[event.code];
  if (!action) { return; }
  event.preventDefault();
  if (pressedCodes.has(event.code)) { return; }
  pressedCodes.add(event.code);
  act(action);
});
document.addEventListener('keyup', (event) => {
  const action = definition.keys[event.code];
  pressedCodes.delete(event.code);
  if (action) { event.preventDefault(); act(action, false); }
});
window.addEventListener('blur', () => { setPaused(true); });
document.addEventListener('visibilitychange', () => { if (document.hidden) { setPaused(true); } });
window.addEventListener('pagehide', () => { releaseControls(); cancelAnimationFrame(frameId); });
window.addEventListener('pageshow', (event) => { if (event.persisted) { lastFrame = 0; frameId = requestAnimationFrame(frame); } });
frameId = requestAnimationFrame(frame);
