export const COLORS = { background: '#1b1d20', grid: '#292d31', accent: '#9dbdab', blue: '#8fa9c2', gold: '#c6af7b', red: '#c38d86', text: '#d9dce2', muted: '#858992' };
export const DIRECTIONS = { up: [0, -1], right: [1, 0], down: [0, 1], left: [-1, 0] };

export function randomItem(items, random = Math.random) {
  return items[Math.floor(random() * items.length)];
}

export function cellKey(x, y) { return `${x},${y}`; }

export function clearBoard(context, width, height) {
  context.fillStyle = COLORS.background;
  context.fillRect(0, 0, width, height);
}

export function drawCell(context, x, y, size, color, inset = 2) {
  context.fillStyle = color;
  context.fillRect(x * size + inset, y * size + inset, size - inset * 2, size - inset * 2);
}

export function drawGrid(context, columns, rows, size) {
  context.strokeStyle = COLORS.grid;
  context.lineWidth = 1;
  context.beginPath();
  for (let column = 0; column <= columns; column++) {
    context.moveTo(column * size + .5, 0);
    context.lineTo(column * size + .5, rows * size);
  }
  for (let row = 0; row <= rows; row++) {
    context.moveTo(0, row * size + .5);
    context.lineTo(columns * size, row * size + .5);
  }
  context.stroke();
}
