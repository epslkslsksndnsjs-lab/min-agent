#!/usr/bin/env node
'use strict';

// Terminal snake: control with WASD or arrow keys, q to quit
// Non-TTY environments (e.g. piped input) auto-enter demo mode and exit after a fixed number of steps

const COLS = 40;
const ROWS = 20;
const isTTY = !!process.stdin.isTTY;

let snake = [{ x: 10, y: 10 }];
let dir = { x: 1, y: 0 };
let nextDir = dir;
let food = spawnFood();
let score = 0;
let alive = true;

function spawnFood() {
  while (true) {
    const f = {
      x: Math.floor(Math.random() * COLS),
      y: Math.floor(Math.random() * ROWS),
    };
    if (!snake.some((s) => s.x === f.x && s.y === f.y)) return f;
  }
}

function step() {
  dir = nextDir;
  const head = { x: snake[0].x + dir.x, y: snake[0].y + dir.y };
  if (
    head.x < 0 || head.x >= COLS || head.y < 0 || head.y >= ROWS ||
    snake.some((s) => s.x === head.x && s.y === head.y)
  ) {
    alive = false;
    return;
  }
  snake.unshift(head);
  if (head.x === food.x && head.y === food.y) {
    score++;
    food = spawnFood();
  } else {
    snake.pop();
  }
}

function render() {
  const grid = Array.from({ length: ROWS }, () => new Array(COLS).fill(' '));
  for (const s of snake) grid[s.y][s.x] = '#';
  grid[snake[0].y][snake[0].x] = '@';
  grid[food.y][food.x] = '*';
  let out = '\x1b[2J\x1b[H' + '='.repeat(COLS + 2) + '\n';
  for (const row of grid) out += '|' + row.join('') + '|\n';
  out += '='.repeat(COLS + 2) + '\n';
  out += `Score: ${score}   Controls: WASD/arrows   Quit: q`;
  return out;
}

function gameOver() {
  console.log('\x1b[2J\x1b[H' + render().split('\n').slice(0, ROWS + 2).join('\n'));
  console.log(`\nGame over! Final score: ${score}`);
  process.exit(0);
}

if (isTTY) {
  const readline = require('readline');
  readline.emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();

  const KEYMAP = {
    up: { x: 0, y: -1 }, down: { x: 0, y: 1 },
    left: { x: -1, y: 0 }, right: { x: 1, y: 0 },
    w: { x: 0, y: -1 }, s: { x: 0, y: 1 },
    a: { x: -1, y: 0 }, d: { x: 1, y: 0 },
  };

  process.stdin.on('keypress', (str, key) => {
    if (key.name === 'q' || (key.ctrl && key.name === 'c')) {
      process.stdout.write('\x1b[?25h\x1b[0m');
      process.exit(0);
    }
    const nd = KEYMAP[key.name];
    if (nd && !(nd.x === -dir.x && nd.y === -dir.y)) nextDir = nd;
  });

  process.stdout.write('\x1b[?25l'); // hide cursor
  console.log(render());
  const speed = setInterval(() => {
    step();
    if (!alive) { clearInterval(speed); gameOver(); return; }
    console.log(render());
  }, 140);
} else {
  // Demo mode: runs automatically when no TTY is present, for testing
  let steps = 0;
  const speed = setInterval(() => {
    step();
    console.log(render());
    steps++;
    if (!alive || steps > 30) { clearInterval(speed); process.exit(0); }
  }, 50);
}
