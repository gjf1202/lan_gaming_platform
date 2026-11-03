import { COLORS, DIRECTIONS, clearBoard, randomItem } from './core.js';

const CELL = 20;
const SIZE = 26;
const FIELD = SIZE * CELL;
const TANK_SIZE = 28;
const PLAYER_SPEED = 100;
const BULLET_SPEED = 300;
const STAGE_COUNTS = [12, 16, 20];
const SPAWNS = [{ x: 40, y: 20 }, { x: 260, y: 20 }, { x: 480, y: 20 }];
const PLAYER_SPAWNS = [{ x: 180, y: 490 }, { x: 340, y: 490 }];
const BASE = { x: 240, y: 480, width: 40, height: 40 };
const KEY_ORDER = ['up', 'left', 'down', 'right'];

function intersects(first, second) {
  return first.x < second.x + second.width && first.x + first.width > second.x && first.y < second.y + second.height && first.y + first.height > second.y;
}

function tankRect(tank) { return { x: tank.x - TANK_SIZE / 2, y: tank.y - TANK_SIZE / 2, width: TANK_SIZE, height: TANK_SIZE }; }

export function createMap(stage) {
  const map = Array.from({ length: SIZE }, () => Array(SIZE).fill(0));
  for (let row = 4; row < 21; row++) {
    for (let column = 2; column < 24; column++) {
      const pillar = [2, 3, 6, 7, 10, 11, 14, 15, 18, 19, 22, 23].includes(column);
      if (pillar && row % 8 < 6) { map[row][column] = stage >= 2 && row >= 12 && column % 8 < 4 ? 2 : 1; }
      if (row >= 9 && row <= 10 && (column === 12 || column === 13)) { map[row][column] = 3; }
      if (row >= 17 && row <= 18 && column >= 8 && column <= 17) { map[row][column] = 4; }
    }
  }
  for (let row = 23; row < SIZE; row++) {
    for (let column = 11; column <= 14; column++) {
      if (row === 23 || column === 11 || column === 14) { map[row][column] = 1; }
    }
  }
  return map;
}

export class TankGame {
  constructor(option = 'solo', random = Math.random) {
    this.random = random;
    this.stage = 1;
    this.score = 0;
    this.kills = 0;
    this.over = false;
    this.won = false;
    this.baseAlive = true;
    this.keys = new Set();
    this.players = PLAYER_SPAWNS.slice(0, option === 'duo' ? 2 : 1).map((spawn, index) => ({ ...spawn, id: `player${index}`, player: true, direction: 'up', lives: 3, shield: 3, power: 0, cooldown: 0, respawn: 0, alive: true }));
    this.setupStage();
  }

  setupStage() {
    this.map = createMap(this.stage);
    this.enemies = [];
    this.bullets = [];
    this.effects = [];
    this.pickups = [];
    this.toSpawn = STAGE_COUNTS[this.stage - 1];
    this.spawnTime = .5;
    this.clearTime = 0;
    this.baseAlive = true;
    this.players.forEach((player, index) => {
      Object.assign(player, PLAYER_SPAWNS[index], { direction: 'up', shield: 3, alive: player.lives > 0, respawn: 0 });
    });
  }

  input(action, pressed) {
    if (this.players.length === 1 && action.startsWith('p2-')) { action = action.slice(3); }
    if (pressed && action.endsWith('fire')) {
      const player = this.players[action.startsWith('p2-') ? 1 : 0];
      if (player) { this.shoot(player); }
    }
    if (pressed) { this.keys.delete(action); this.keys.add(action); }
    else { this.keys.delete(action); }
  }

  occupied(rectangle, self) {
    if (rectangle.x < 0 || rectangle.y < 0 || rectangle.x + rectangle.width > FIELD || rectangle.y + rectangle.height > FIELD) { return true; }
    if (intersects(rectangle, BASE)) { return true; }
    const left = Math.floor(rectangle.x / CELL);
    const right = Math.floor((rectangle.x + rectangle.width - .01) / CELL);
    const top = Math.floor(rectangle.y / CELL);
    const bottom = Math.floor((rectangle.y + rectangle.height - .01) / CELL);
    for (let row = top; row <= bottom; row++) {
      for (let column = left; column <= right; column++) {
        if ([1, 2, 3].includes(this.map[row][column])) { return true; }
      }
    }
    return [...this.players, ...this.enemies].some((tank) => tank !== self && tank.alive && intersects(rectangle, tankRect(tank)));
  }

  move(tank, direction, distance) {
    tank.direction = direction;
    const [offsetX, offsetY] = DIRECTIONS[direction];
    const next = { ...tank, x: tank.x + offsetX * distance, y: tank.y + offsetY * distance };
    if (this.occupied(tankRect(next), tank)) { return false; }
    tank.x = next.x;
    tank.y = next.y;
    return true;
  }

  shoot(tank) {
    if (tank.cooldown > 0 || !tank.alive) { return; }
    const owned = this.bullets.filter((bullet) => bullet.owner === tank.id).length;
    if (owned >= (tank.player && tank.power > 0 ? 3 : 2)) { return; }
    const [offsetX, offsetY] = DIRECTIONS[tank.direction];
    this.bullets.push({ x: tank.x + offsetX * 19, y: tank.y + offsetY * 19, offsetX, offsetY, player: tank.player, owner: tank.id, power: tank.player && tank.power > 0, alive: true });
    tank.cooldown = tank.player ? .32 : 1.1 + this.random() * 1.4;
  }

  spawnEnemy() {
    if (this.toSpawn <= 0 || this.enemies.length >= 4) { return; }
    const available = SPAWNS.filter((spawn) => !this.occupied(tankRect(spawn), null));
    if (!available.length) { return; }
    const armored = this.stage > 1 && this.toSpawn % 4 === 0;
    this.enemies.push({ ...randomItem(available, this.random), id: `enemy${this.stage}-${this.toSpawn}`, player: false, direction: 'down', alive: true, health: armored ? 2 : 1, cooldown: 1, turnTime: 1, shield: .7 });
    this.toSpawn--;
  }

  updatePlayer(player, index, delta) {
    player.cooldown = Math.max(0, player.cooldown - delta);
    player.shield = Math.max(0, player.shield - delta);
    player.power = Math.max(0, player.power - delta);
    if (!player.alive) {
      if (player.lives <= 0) { return; }
      player.respawn -= delta;
      const spawn = PLAYER_SPAWNS[index];
      if (player.respawn <= 0 && !this.occupied(tankRect(spawn), player)) {
        Object.assign(player, spawn, { alive: true, shield: 3, direction: 'up' });
      }
      return;
    }
    const prefix = index === 0 ? '' : 'p2-';
    const direction = [...this.keys].reverse().find((key) => key.startsWith(prefix) && KEY_ORDER.includes(key.slice(prefix.length)));
    if (direction) { this.move(player, direction.slice(prefix.length), PLAYER_SPEED * delta); }
    if (this.keys.has(`${prefix}fire`)) { this.shoot(player); }
    this.collectPickup(player);
  }

  updateEnemy(enemy, delta) {
    enemy.cooldown = Math.max(0, enemy.cooldown - delta);
    enemy.shield = Math.max(0, enemy.shield - delta);
    enemy.turnTime -= delta;
    const moved = this.move(enemy, enemy.direction, (48 + this.stage * 7) * delta);
    if (!moved || enemy.turnTime <= 0) {
      const choices = ['down', 'down', 'down', 'left', 'right', 'up'];
      enemy.direction = randomItem(choices, this.random);
      enemy.turnTime = .5 + this.random() * 1.5;
    }
    this.shoot(enemy);
  }

  collectPickup(player) {
    for (const pickup of this.pickups) {
      if (pickup.life <= 0 || Math.hypot(player.x - pickup.x, player.y - pickup.y) > 27) { continue; }
      if (pickup.type === 'life') { player.lives = Math.min(6, player.lives + 1); }
      if (pickup.type === 'shield') { player.shield = 10; }
      if (pickup.type === 'power') { player.power = 20; }
      pickup.life = 0;
      this.score += 50;
    }
  }

  hitTank(tank) {
    if (tank.shield > 0) { return; }
    if (!tank.player && --tank.health > 0) { return; }
    tank.alive = false;
    this.effects.push({ x: tank.x, y: tank.y, life: .3 });
    if (tank.player) {
      tank.lives--;
      tank.respawn = 1;
      tank.power = 0;
      return;
    }
    this.score += 100;
    this.kills++;
    if (this.kills % 4 === 0) { this.pickups.push({ x: tank.x, y: tank.y, type: randomItem(['life', 'shield', 'power'], this.random), life: 15 }); }
  }

  updateBullet(bullet, delta) {
    bullet.x += bullet.offsetX * BULLET_SPEED * delta;
    bullet.y += bullet.offsetY * BULLET_SPEED * delta;
    const rectangle = { x: bullet.x - 3, y: bullet.y - 3, width: 6, height: 6 };
    if (bullet.x < 0 || bullet.y < 0 || bullet.x >= FIELD || bullet.y >= FIELD) { bullet.alive = false; return; }
    if (intersects(rectangle, BASE)) {
      bullet.alive = false;
      // Friendly fire never damages the base or a teammate.
      if (!bullet.player) { this.baseAlive = false; this.over = true; }
      return;
    }
    for (let row = Math.max(0, Math.floor(rectangle.y / CELL)); row <= Math.min(SIZE - 1, Math.floor((rectangle.y + 6) / CELL)); row++) {
      for (let column = Math.max(0, Math.floor(rectangle.x / CELL)); column <= Math.min(SIZE - 1, Math.floor((rectangle.x + 6) / CELL)); column++) {
        const tile = this.map[row][column];
        if (tile !== 1 && tile !== 2) { continue; }
        if (tile === 1 || bullet.power) { this.map[row][column] = 0; }
        bullet.alive = false;
      }
    }
    if (!bullet.alive) { return; }
    const targets = bullet.player ? this.enemies : this.players;
    const target = targets.find((tank) => tank.alive && intersects(rectangle, tankRect(tank)));
    if (target) { bullet.alive = false; this.hitTank(target); }
  }

  update(delta) {
    // Small physics steps prevent fast projectiles from skipping a wall or tank.
    let remaining = delta;
    while (remaining > 0 && !this.over) {
      const step = Math.min(remaining, .016);
      this.tick(step);
      remaining -= step;
    }
  }

  tick(delta) {
    if (this.clearTime > 0) {
      this.clearTime -= delta;
      if (this.clearTime <= 0) { this.stage++; this.setupStage(); }
      return;
    }
    this.spawnTime -= delta;
    if (this.spawnTime <= 0) { this.spawnEnemy(); this.spawnTime = 2; }
    this.players.forEach((player, index) => { this.updatePlayer(player, index, delta); });
    this.enemies.forEach((enemy) => { this.updateEnemy(enemy, delta); });
    for (const bullet of this.bullets) { if (bullet.alive) { this.updateBullet(bullet, delta); } }
    for (let first = 0; first < this.bullets.length; first++) {
      for (let second = first + 1; second < this.bullets.length; second++) {
        const one = this.bullets[first];
        const two = this.bullets[second];
        if (one.alive && two.alive && one.player !== two.player && Math.hypot(one.x - two.x, one.y - two.y) < 9) { one.alive = false; two.alive = false; }
      }
    }
    this.bullets = this.bullets.filter((bullet) => bullet.alive);
    this.enemies = this.enemies.filter((enemy) => enemy.alive);
    this.effects.forEach((effect) => { effect.life -= delta; });
    this.effects = this.effects.filter((effect) => effect.life > 0);
    this.pickups.forEach((pickup) => { pickup.life -= delta; });
    this.pickups = this.pickups.filter((pickup) => pickup.life > 0);
    if (this.players.every((player) => player.lives <= 0)) { this.over = true; }
    if (!this.over && this.toSpawn === 0 && this.enemies.length === 0) {
      if (this.stage === STAGE_COUNTS.length) { this.over = true; this.won = true; }
      else { this.clearTime = 2; this.score += 300; }
    }
  }

  stats() {
    return { score: this.score, metrics: [['关卡', `${this.stage} / ${STAGE_COUNTS.length}`], ['剩余敌军', this.toSpawn + this.enemies.length], ...this.players.map((player, index) => [`${index + 1}号生命`, player.lives]), ['基地', this.baseAlive ? '完好' : '失守']], detail: `第 ${this.stage} 关`, message: this.over ? this.won ? '三关守住了，合作愉快！' : this.baseAlive ? '生命耗尽了，再来一局吧。' : '基地失守了，再试一次吧。' : this.clearTime > 0 ? '本关完成，即将进入下一关。' : '击败敌军并保护底部基地。道具：命、盾、强。' };
  }

  drawTank(context, tank) {
    if (!tank.alive) { return; }
    context.save();
    context.translate(tank.x, tank.y);
    context.rotate({ up: 0, right: Math.PI / 2, down: Math.PI, left: -Math.PI / 2 }[tank.direction]);
    const color = tank.player ? tank.id === 'player0' ? COLORS.accent : COLORS.blue : tank.health > 1 ? '#b9a6b9' : COLORS.red;
    context.fillStyle = '#626a6b';
    context.fillRect(-14, -14, 7, 28);
    context.fillRect(7, -14, 7, 28);
    context.fillStyle = color;
    context.fillRect(-9, -11, 18, 23);
    context.fillRect(-3, -22, 6, 20);
    context.fillStyle = '#35423b';
    context.fillRect(-5, -5, 10, 11);
    if (tank.shield > 0) { context.strokeStyle = '#cbdacb'; context.strokeRect(-17, -17, 34, 34); }
    context.restore();
  }

  drawTerrain(context, forest = false) {
    this.map.forEach((row, rowIndex) => row.forEach((tile, columnIndex) => {
      if (!tile || (tile === 4) !== forest) { return; }
      const left = columnIndex * CELL;
      const top = rowIndex * CELL;
      context.fillStyle = ({ 1: '#806c58', 2: '#6f7b83', 3: '#324d61', 4: '#3a5847' })[tile];
      context.fillRect(left + 1, top + 1, CELL - 2, CELL - 2);
      context.strokeStyle = tile === 1 ? '#a28b73' : '#9bada02b';
      context.strokeRect(left + 3, top + 3, CELL - 6, CELL - 6);
      if (tile === 1) { context.fillStyle = '#32302c'; context.fillRect(left, top + 9, CELL, 2); }
    }));
  }

  render(context) {
    clearBoard(context, FIELD, FIELD);
    this.drawTerrain(context);
    context.fillStyle = this.baseAlive ? '#a9aa8e' : '#665451';
    context.fillRect(BASE.x + 3, BASE.y + 3, BASE.width - 6, BASE.height - 6);
    context.fillStyle = '#232a28';
    context.font = 'bold 22px "Microsoft YaHei", sans-serif';
    context.fillText('守', BASE.x + 8, BASE.y + 29);
    [...this.players, ...this.enemies].forEach((tank) => { this.drawTank(context, tank); });
    this.bullets.forEach((bullet) => { context.fillStyle = bullet.player ? '#d6dfc4' : '#d7aaa2'; context.fillRect(bullet.x - 3, bullet.y - 3, 6, 6); });
    this.drawTerrain(context, true);
    this.pickups.forEach((pickup) => {
      context.fillStyle = '#354d3e'; context.fillRect(pickup.x - 14, pickup.y - 14, 28, 28);
      context.fillStyle = '#d6dfc4'; context.font = '16px "Microsoft YaHei", sans-serif';
      context.fillText(({ life: '命', shield: '盾', power: '强' })[pickup.type], pickup.x - 8, pickup.y + 6);
    });
    this.effects.forEach((effect) => { context.strokeStyle = COLORS.gold; context.lineWidth = 3; context.beginPath(); context.arc(effect.x, effect.y, 32 * (1 - effect.life / .3), 0, Math.PI * 2); context.stroke(); });
  }
}

export const definition = {
  id: 'tank', title: '90坦克', description: '守住基地，并肩闯关。', mode: '单人 / 同机双人 · 三关守卫', width: FIELD, height: FIELD,
  optionLabel: '游玩人数', options: [['solo', '单人守卫'], ['duo', '同机双人合作']], defaultOption: 'solo',
  rules: '消灭每关敌军，保护底部基地。砖墙可打碎，钢墙需强化炮弹，水面不可通过，树林能遮挡坦克。生命耗尽或基地失守时结束。',
  keys: { KeyW: 'up', KeyA: 'left', KeyS: 'down', KeyD: 'right', KeyJ: 'fire', Space: 'fire', ArrowUp: 'p2-up', ArrowLeft: 'p2-left', ArrowDown: 'p2-down', ArrowRight: 'p2-right', Enter: 'p2-fire' },
  help: [['一号 W A S D / J', '移动 / 射击（空格也可）'], ['二号 方向键 / 回车', '双人模式下移动 / 射击'], ['P / 退出键', '暂停或继续']],
  controls: [['up', '↑'], ['left', '←'], ['down', '↓'], ['right', '→'], ['fire', '开火']],
  note: '单人也可用方向键与回车。双人共用一台电脑，画面由代码自绘。', create: (option) => new TankGame(option)
};
