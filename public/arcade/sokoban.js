import { COLORS, DIRECTIONS, cellKey, clearBoard, drawCell } from './core.js';

const CELL = 48;
export const LEVELS = [
  ['初见', ['#######', '#     #', '# @$. #', '#     #', '#######']],
  ['分路', ['#######', '#  .  #', '#  $  #', '#  $ .#', '# @   #', '#######']],
  ['绕行', ['########', '#   #  #', '# . $  #', '#   # .#', '# @ $  #', '#      #', '########']],
  ['并肩', ['########', '#      #', '# ..   #', '# $$ # #', '#  @   #', '#      #', '########']],
  ['转角', ['########', '#  .   #', '#  #   #', '#  $ $ #', '# .#   #', '#  @   #', '#      #', '########']],
  ['三步思量', ['########', '# . . .#', '#      #', '# $ $ $#', '#  @   #', '#      #', '########']],
  ['穿巷', ['#########', '#   .   #', '# #   # #', '# $ $   #', '#     . #', '# @     #', '#########']],
  ['归位', ['#########', '# .   . #', '#   #   #', '# $   $ #', '#   $   #', '# . #   #', '#   @   #', '#########']]
];

export class SokobanGame {
  constructor(option = '0') {
    this.level = Math.max(0, Math.min(LEVELS.length - 1, Number(option) || 0));
    const [title, layout] = LEVELS[this.level];
    this.title = title;
    this.rows = layout.length;
    this.columns = Math.max(...layout.map((row) => row.length));
    this.walls = new Set();
    this.floor = new Set();
    this.goals = new Set();
    this.boxes = new Set();
    this.history = [];
    this.score = 0;
    this.pushes = 0;
    this.over = false;
    this.won = false;
    layout.forEach((row, rowIndex) => [...row].forEach((tile, columnIndex) => {
      const key = cellKey(columnIndex, rowIndex);
      if (tile === '#') { this.walls.add(key); return; }
      this.floor.add(key);
      if (['.', '*', '+'].includes(tile)) { this.goals.add(key); }
      if (['$', '*'].includes(tile)) { this.boxes.add(key); }
      if (['@', '+'].includes(tile)) { this.player = { x: columnIndex, y: rowIndex }; }
    }));
  }

  input(action, pressed) {
    if (!pressed) { return; }
    if (action === 'undo') { this.undo(); return; }
    if (this.over || !DIRECTIONS[action]) { return; }
    const [offsetX, offsetY] = DIRECTIONS[action];
    const next = { x: this.player.x + offsetX, y: this.player.y + offsetY };
    const nextKey = cellKey(next.x, next.y);
    if (!this.floor.has(nextKey)) { return; }
    const pushing = this.boxes.has(nextKey);
    const destination = cellKey(next.x + offsetX, next.y + offsetY);
    if (pushing && (!this.floor.has(destination) || this.boxes.has(destination))) { return; }
    this.history.push({ player: this.player, boxes: new Set(this.boxes), pushes: this.pushes });
    if (pushing) {
      this.boxes.delete(nextKey);
      this.boxes.add(destination);
      this.pushes++;
    }
    this.player = next;
    this.score++;
    this.won = [...this.goals].every((goal) => this.boxes.has(goal));
    this.over = this.won;
  }

  undo() {
    const previous = this.history.pop();
    if (!previous) { return; }
    this.player = previous.player;
    this.boxes = previous.boxes;
    this.pushes = previous.pushes;
    this.score--;
    this.over = false;
    this.won = false;
  }

  update() {}

  stats() {
    const placed = [...this.goals].filter((goal) => this.boxes.has(goal)).length;
    const trapped = [...this.boxes].some((box) => {
      if (this.goals.has(box)) { return false; }
      const [column, row] = box.split(',').map(Number);
      return [1, -1].some((offsetX) => [1, -1].some((offsetY) => !this.floor.has(cellKey(column + offsetX, row)) && !this.floor.has(cellKey(column, row + offsetY))));
    });
    return { score: this.score, metrics: [['关卡', `${this.level + 1} / ${LEVELS.length}`], ['归位', `${placed} / ${this.goals.size}`], ['推动次数', this.pushes]], detail: this.title, message: this.won ? '全部归位！可以进入下一关，或悔步继续优化。' : trapped ? '箱子卡在墙角了，可以悔步或重玩本关。' : '箱子只能推动，不能拉回；一步只推一只。' };
  }

  render(context) {
    clearBoard(context, 480, 480);
    const offsetX = Math.floor((480 - this.columns * CELL) / 2);
    const offsetY = Math.floor((480 - this.rows * CELL) / 2);
    context.save();
    context.translate(offsetX, offsetY);
    for (const key of this.floor) {
      const [column, row] = key.split(',').map(Number);
      drawCell(context, column, row, CELL, '#272c2e', 1);
    }
    for (const key of this.walls) {
      const [column, row] = key.split(',').map(Number);
      drawCell(context, column, row, CELL, '#454c50', 1);
      context.fillStyle = '#555e62';
      context.fillRect(column * CELL + 3, row * CELL + 3, CELL - 6, 3);
    }
    for (const key of this.goals) {
      const [column, row] = key.split(',').map(Number);
      context.strokeStyle = COLORS.accent;
      context.lineWidth = 2;
      context.beginPath();
      context.arc((column + .5) * CELL, (row + .5) * CELL, 9, 0, Math.PI * 2);
      context.stroke();
    }
    for (const key of this.boxes) {
      const [column, row] = key.split(',').map(Number);
      const placed = this.goals.has(key);
      drawCell(context, column, row, CELL, placed ? '#72967d' : '#a28d66', 6);
      context.strokeStyle = placed ? '#bbd3be' : '#d2bb91';
      context.lineWidth = 2;
      context.strokeRect(column * CELL + 11, row * CELL + 11, CELL - 22, CELL - 22);
      context.beginPath();
      context.moveTo(column * CELL + 12, row * CELL + 12);
      context.lineTo((column + 1) * CELL - 12, (row + 1) * CELL - 12);
      context.moveTo((column + 1) * CELL - 12, row * CELL + 12);
      context.lineTo(column * CELL + 12, (row + 1) * CELL - 12);
      context.stroke();
    }
    context.fillStyle = COLORS.blue;
    context.beginPath();
    context.arc((this.player.x + .5) * CELL, (this.player.y + .5) * CELL, 14, 0, Math.PI * 2);
    context.fill();
    context.fillStyle = '#d5e0e9';
    context.fillRect(this.player.x * CELL + 17, this.player.y * CELL + 17, 4, 4);
    context.fillRect(this.player.x * CELL + 27, this.player.y * CELL + 17, 4, 4);
    context.restore();
  }
}

export const definition = {
  id: 'sokoban', title: '推箱子', description: '一步一步，把箱子送回家。', mode: '单人 · 八关解谜', width: 480, height: 480,
  optionLabel: '选择关卡', options: LEVELS.map(([title], index) => [String(index), `第 ${index + 1} 关 · ${title}`]), defaultOption: '0',
  scoreLabel: '步数', bestLabel: '本关最少', lowerBest: true,
  rules: '把所有箱子推到圆圈标记的位置。只能推、不能拉，箱子卡住时可以悔步。所有关卡都可直接选择。',
  keys: { ArrowUp: 'up', KeyW: 'up', ArrowDown: 'down', KeyS: 'down', ArrowLeft: 'left', KeyA: 'left', ArrowRight: 'right', KeyD: 'right', KeyU: 'undo', Backspace: 'undo' },
  help: [['方向键 / W A S D', '移动并推动箱子'], ['U / 退格键', '撤回一步'], ['P / 空格', '暂停或继续']],
  controls: [['up', '↑'], ['left', '←'], ['down', '↓'], ['right', '→'], ['undo', '悔步']],
  repeatActions: ['up', 'down', 'left', 'right'], extras: [['undo', '悔步'], ['next', '下一关']],
  create: (option) => new SokobanGame(option)
};
