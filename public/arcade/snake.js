import { COLORS, DIRECTIONS, cellKey, clearBoard, drawCell, drawGrid, randomItem } from './core.js';

const SIZE = 20;
const CELL = 24;
const SPEEDS = { easy: .18, normal: .13, fast: .09 };

export class SnakeGame {
  constructor(option = 'normal', random = Math.random) {
    this.random = random;
    this.speed = SPEEDS[option] || SPEEDS.normal;
    this.snake = [{ x: 9, y: 10 }, { x: 8, y: 10 }, { x: 7, y: 10 }];
    this.direction = 'right';
    this.queue = [];
    this.elapsed = 0;
    this.score = 0;
    this.over = false;
    this.won = false;
    this.food = this.placeFood();
  }

  placeFood() {
    const occupied = new Set(this.snake.map(({ x, y }) => cellKey(x, y)));
    const available = [];
    for (let row = 0; row < SIZE; row++) {
      for (let column = 0; column < SIZE; column++) {
        if (!occupied.has(cellKey(column, row))) { available.push({ x: column, y: row }); }
      }
    }
    return available.length ? randomItem(available, this.random) : null;
  }

  input(action, pressed) {
    if (!pressed || !DIRECTIONS[action] || this.queue.length >= 2) { return; }
    const previous = this.queue.at(-1) || this.direction;
    const [previousX, previousY] = DIRECTIONS[previous];
    const [nextX, nextY] = DIRECTIONS[action];
    if (previousX + nextX === 0 && previousY + nextY === 0 || previous === action) { return; }
    this.queue.push(action);
  }

  update(delta) {
    this.elapsed += delta;
    const interval = Math.max(.055, this.speed - Math.floor(this.score / 50) * .008);
    while (this.elapsed >= interval && !this.over) {
      this.elapsed -= interval;
      this.step();
    }
  }

  step() {
    this.direction = this.queue.shift() || this.direction;
    const [offsetX, offsetY] = DIRECTIONS[this.direction];
    const head = { x: this.snake[0].x + offsetX, y: this.snake[0].y + offsetY };
    const eating = this.food && head.x === this.food.x && head.y === this.food.y;
    const body = eating ? this.snake : this.snake.slice(0, -1);
    if (head.x < 0 || head.y < 0 || head.x >= SIZE || head.y >= SIZE || body.some(({ x, y }) => x === head.x && y === head.y)) {
      this.over = true;
      return;
    }
    this.snake.unshift(head);
    if (!eating) { this.snake.pop(); return; }
    this.score += 10;
    this.food = this.placeFood();
    if (!this.food) { this.over = true; this.won = true; }
  }

  stats() {
    return { score: this.score, metrics: [['长度', this.snake.length], ['速度', `${(1 / Math.max(.055, this.speed - Math.floor(this.score / 50) * .008)).toFixed(1)} 格/秒`]], detail: '20 × 20', message: this.over ? this.won ? '棋盘填满了，恭喜通关！' : '碰到墙壁或自己了，再来一局吧。' : '每吃一个点心加 10 分。' };
  }

  render(context) {
    clearBoard(context, SIZE * CELL, SIZE * CELL);
    drawGrid(context, SIZE, SIZE, CELL);
    if (this.food) {
      context.fillStyle = COLORS.gold;
      context.beginPath();
      context.arc((this.food.x + .5) * CELL, (this.food.y + .5) * CELL, 6, 0, Math.PI * 2);
      context.fill();
    }
    this.snake.forEach(({ x, y }, index) => { drawCell(context, x, y, CELL, index === 0 ? '#bdd7c6' : '#668976'); });
    const head = this.snake[0];
    const [directionX, directionY] = DIRECTIONS[this.direction];
    context.fillStyle = '#263c30';
    for (const sign of [-1, 1]) {
      context.fillRect((head.x + .5) * CELL + directionX * 5 + directionY * sign * 4 - 1.5, (head.y + .5) * CELL + directionY * 5 + directionX * sign * 4 - 1.5, 3, 3);
    }
  }
}

export const definition = {
  id: 'snake', title: '贪吃蛇', description: '吃点心，慢慢长大。', mode: '单人 · 经典玩法', width: 480, height: 480,
  optionLabel: '起始速度', options: [['easy', '悠闲'], ['normal', '标准'], ['fast', '快速']], defaultOption: 'normal',
  rules: '控制小蛇吃点心，避免撞墙或碰到自己。吃得越多，速度越快。',
  keys: { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right' },
  help: [['↑ ↓ ← →', '改变方向'], ['W / A / S / D', '也可控制方向'], ['空格 / P', '暂停或继续']],
  controls: [['up', '↑'], ['left', '←'], ['down', '↓'], ['right', '→']],
  create: (option) => new SnakeGame(option)
};
