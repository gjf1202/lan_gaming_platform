import { COLORS, clearBoard, drawCell, drawGrid } from './core.js';

const COLUMNS = 10;
const ROWS = 20;
const CELL = 24;
const SHAPES = {
  I: [[0, 0, 0, 0], [1, 1, 1, 1], [0, 0, 0, 0], [0, 0, 0, 0]],
  O: [[1, 1], [1, 1]], T: [[0, 1, 0], [1, 1, 1], [0, 0, 0]],
  J: [[1, 0, 0], [1, 1, 1], [0, 0, 0]], L: [[0, 0, 1], [1, 1, 1], [0, 0, 0]],
  S: [[0, 1, 1], [1, 1, 0], [0, 0, 0]], Z: [[1, 1, 0], [0, 1, 1], [0, 0, 0]]
};
const BLOCK_COLORS = { I: '#85b8b8', O: '#c6b47d', T: '#ac9abb', J: '#829fbc', L: '#c5a17d', S: '#93b394', Z: '#bf918d' };
const LINE_SCORES = [0, 100, 300, 500, 800];
const LOCK_DELAY = .45;

export class TetrisGame {
  constructor(option = '1', random = Math.random) {
    this.random = random;
    this.board = Array.from({ length: ROWS }, () => Array(COLUMNS).fill(null));
    this.bag = [];
    this.next = Array.from({ length: 3 }, () => this.takeType());
    this.hold = null;
    this.holdUsed = false;
    this.startLevel = [1, 5, 10].includes(Number(option)) ? Number(option) : 1;
    this.level = this.startLevel;
    this.lines = 0;
    this.score = 0;
    this.elapsed = 0;
    this.lockTime = 0;
    this.lockResets = 0;
    this.over = false;
    this.won = false;
    this.spawn();
  }

  takeType() {
    if (!this.bag.length) {
      this.bag = Object.keys(SHAPES);
      for (let index = this.bag.length - 1; index > 0; index--) {
        const selected = Math.floor(this.random() * (index + 1));
        [this.bag[index], this.bag[selected]] = [this.bag[selected], this.bag[index]];
      }
    }
    return this.bag.pop();
  }

  spawn(type) {
    const nextType = type || this.next.shift();
    if (!type) { this.next.push(this.takeType()); }
    const matrix = SHAPES[nextType].map((row) => [...row]);
    this.piece = { type: nextType, matrix, x: Math.floor((COLUMNS - matrix.length) / 2), y: -1 };
    this.elapsed = 0;
    this.lockTime = 0;
    this.lockResets = 0;
    if (!this.fits(this.piece)) { this.over = true; }
  }

  fits(piece) {
    return piece.matrix.every((row, rowIndex) => row.every((filled, columnIndex) => {
      if (!filled) { return true; }
      const column = piece.x + columnIndex;
      const line = piece.y + rowIndex;
      return column >= 0 && column < COLUMNS && line < ROWS && (line < 0 || !this.board[line][column]);
    }));
  }

  move(offsetX, offsetY) {
    const grounded = !this.fits({ ...this.piece, y: this.piece.y + 1 });
    const next = { ...this.piece, x: this.piece.x + offsetX, y: this.piece.y + offsetY };
    if (!this.fits(next)) { return false; }
    this.piece = next;
    if (offsetY > 0) { this.lockTime = 0; }
    else if (grounded && this.lockResets < 15) { this.lockTime = 0; this.lockResets++; }
    return true;
  }

  rotate(clockwise) {
    const original = this.piece.matrix;
    const matrix = original.map((row, rowIndex) => row.map((value, columnIndex) => clockwise ? original[original.length - 1 - columnIndex][rowIndex] : original[columnIndex][original.length - 1 - rowIndex]));
    // Small wall and floor kicks keep pieces usable near a boundary.
    for (const [offsetX, offsetY] of [[0, 0], [-1, 0], [1, 0], [-2, 0], [2, 0], [0, -1], [0, -2]]) {
      const next = { ...this.piece, matrix, x: this.piece.x + offsetX, y: this.piece.y + offsetY };
      if (this.fits(next)) {
        this.piece = next;
        if (this.lockResets < 15) { this.lockTime = 0; this.lockResets++; }
        return;
      }
    }
  }

  input(action, pressed) {
    if (!pressed || this.over) { return; }
    if (action === 'left' || action === 'right') { this.move(action === 'left' ? -1 : 1, 0); }
    if (action === 'down' && this.move(0, 1)) { this.score++; }
    if (action === 'rotate' || action === 'reverse') { this.rotate(action === 'rotate'); }
    if (action === 'drop') {
      while (this.move(0, 1)) { this.score += 2; }
      this.lock();
    }
    if (action === 'hold' && !this.holdUsed) {
      const current = this.piece.type;
      this.spawn(this.hold || undefined);
      this.hold = current;
      this.holdUsed = true;
    }
  }

  lock() {
    const { matrix, x, y, type } = this.piece;
    if (matrix.some((row, rowIndex) => row.some((filled) => filled && y + rowIndex < 0))) { this.over = true; return; }
    matrix.forEach((row, rowIndex) => row.forEach((filled, columnIndex) => {
      if (filled) { this.board[y + rowIndex][x + columnIndex] = type; }
    }));
    const remaining = this.board.filter((row) => row.some((cell) => !cell));
    const cleared = ROWS - remaining.length;
    this.score += LINE_SCORES[cleared] * this.level;
    this.lines += cleared;
    this.level = this.startLevel + Math.floor(this.lines / 10);
    this.board = [...Array.from({ length: cleared }, () => Array(COLUMNS).fill(null)), ...remaining];
    this.holdUsed = false;
    this.spawn();
  }

  update(delta) {
    if (this.over) { return; }
    const grounded = !this.fits({ ...this.piece, y: this.piece.y + 1 });
    this.lockTime = grounded ? this.lockTime + delta : 0;
    if (this.lockTime >= LOCK_DELAY) { this.lock(); return; }
    this.elapsed += delta;
    const interval = Math.max(.06, .8 * Math.pow(.82, this.level - 1));
    if (this.elapsed >= interval) { this.elapsed %= interval; this.move(0, 1); }
  }

  stats() {
    return { score: this.score, metrics: [['等级', this.level], ['消行', this.lines], ['暂存', this.hold ? '已有方块' : '空']], detail: `第 ${this.level} 级`, message: this.over ? '方块堆到顶了，再来一局吧。' : '右侧显示接下来三块；虚线表示落点。' };
  }

  drawPiece(context, piece, ghost = false) {
    piece.matrix.forEach((row, rowIndex) => row.forEach((filled, columnIndex) => {
      if (!filled || piece.y + rowIndex < 0) { return; }
      if (ghost) {
        context.strokeStyle = '#718477';
        context.setLineDash([3, 3]);
        context.strokeRect((piece.x + columnIndex) * CELL + 3, (piece.y + rowIndex) * CELL + 3, CELL - 6, CELL - 6);
        context.setLineDash([]);
      } else { drawCell(context, piece.x + columnIndex, piece.y + rowIndex, CELL, BLOCK_COLORS[piece.type], 1); }
    }));
  }

  render(context) {
    clearBoard(context, 360, 480);
    drawGrid(context, COLUMNS, ROWS, CELL);
    this.board.forEach((row, rowIndex) => row.forEach((type, columnIndex) => {
      if (type) { drawCell(context, columnIndex, rowIndex, CELL, BLOCK_COLORS[type], 1); }
    }));
    let ghost = { ...this.piece };
    while (this.fits({ ...ghost, y: ghost.y + 1 })) { ghost.y++; }
    this.drawPiece(context, ghost, true);
    this.drawPiece(context, this.piece);
    context.fillStyle = '#22262a';
    context.fillRect(241, 0, 119, 480);
    const previews = [[this.hold, 45, '暂存'], ...this.next.map((type, index) => [type, 160 + index * 100, index === 0 ? '接下来' : ''])];
    for (const [type, top, label] of previews) {
      context.fillStyle = COLORS.muted;
      context.font = '12px "Microsoft YaHei", sans-serif';
      context.fillText(label, 255, top - 17);
      if (!type) { continue; }
      SHAPES[type].forEach((row, rowIndex) => row.forEach((filled, columnIndex) => {
        if (filled) { context.fillStyle = BLOCK_COLORS[type]; context.fillRect(254 + columnIndex * 21, top + rowIndex * 21, 19, 19); }
      }));
    }
  }
}

export const definition = {
  id: 'tetris', title: '俄罗斯方块', description: '转一转，消去整行。', mode: '单人 · 无尽挑战', width: 360, height: 480,
  optionLabel: '起始等级', options: [['1', '第 1 级 · 悠闲'], ['5', '第 5 级 · 进阶'], ['10', '第 10 级 · 挑战']], defaultOption: '1',
  rules: '把一整行填满即可消除，每消除十行提升一级。方块堆到顶部时结束。支持暂存方块、落点预览和七种方块随机袋。',
  keys: { ArrowLeft: 'left', ArrowRight: 'right', ArrowDown: 'down', ArrowUp: 'rotate', KeyX: 'rotate', KeyZ: 'reverse', Space: 'drop', KeyC: 'hold' },
  help: [['← → / ↓', '平移 / 加速下降'], ['↑ / X；Z', '顺时针；逆时针旋转'], ['空格 / C', '直接落下 / 暂存'], ['P / 退出键', '暂停或继续']],
  controls: [['left', '←'], ['rotate', '旋转'], ['right', '→'], ['down', '↓'], ['drop', '落下'], ['hold', '暂存']],
  repeatActions: ['left', 'right', 'down'], create: (option) => new TetrisGame(option)
};
