// DAYLOG — pixel supercar that drives along the bottom of the app window.
'use strict';
(() => {
  // Original sprite (faces right). One char = one pixel.
  const SPRITE = [
    '............rrrrrrr.............',
    '..........rrkkkkkkwrr...........',
    '........rrrkkkkkkkkkwrrr........',
    'kkk...rrrrrrrrrrrrrrrrrrrrr.....',
    'kdd.rrrrrrrrrrrrrrrrrrrrrrrrrr..',
    '.rrrrrrrwwwwwwrrrrrrrrrrrrrrrrry',
    'orrrrrrrrrrrrrrrrrrrrrrrrrrrrrrr',
    'rrrrddkkkkkddddddddddkkkkkddrrrr',
    '.rrdkkgggkkd........dkkgggkkdrr.',
    '....kgkkkgk..........kgkkkgk....',
    '.....kkkkk............kkkkk.....'
  ];
  const WHEEL_B = { 'kgkkkgk': 'kkgkgkk', 'kkgggkk': 'kgkkkgk' };
  const COLORS = { r: '#d7191c', d: '#8f0f12', k: '#111111', w: '#ffd9d9', g: '#9a9a9a', y: '#ffe680', o: '#ff7a00' };
  const PX = 2, W = SPRITE[0].length * PX, H = SPRITE.length * PX;

  let cv, x, raf = 0, t = 0;
  const car = { x: -W, v: 0, facing: 1, target: 120, idle: 0, top: 2 };
  const puffs = [];

  function resize() {
    cv.width = cv.clientWidth; cv.height = cv.clientHeight;
    x.imageSmoothingEnabled = false;
    car.target = Math.min(car.target, Math.max(0, cv.width - W));
  }
  function pickTarget() {
    car.target = Math.random() * Math.max(0, cv.width - W);
    car.top = Math.random() < 0.25 ? 5 : 1 + Math.random() * 1.5;
  }
  function drawCar(px, py, facing, frame) {
    for (let r = 0; r < SPRITE.length; r++) {
      let row = SPRITE[r];
      if (frame && r >= 8) for (const [a, b] of Object.entries(WHEEL_B)) row = row.split(a).join(b);
      for (let c = 0; c < row.length; c++) {
        const ch = row[c]; if (ch === '.') continue;
        x.fillStyle = COLORS[ch];
        x.fillRect(Math.round(px) + (facing > 0 ? c : row.length - 1 - c) * PX, py + r * PX, PX, PX);
      }
    }
  }
  function step() {
    t++;
    if (cv.width !== cv.clientWidth) resize();
    x.clearRect(0, 0, cv.width, cv.height);
    const dx = car.target - car.x;
    if (car.idle > 0) { car.idle--; car.v *= 0.85; }
    else if (Math.abs(dx) < 3 && Math.abs(car.v) < 0.3) { car.idle = 120 + Math.random() * 360; pickTarget(); }
    else {
      const dir = Math.sign(dx), brake = Math.abs(dx) < car.v * car.v * 6;
      car.v += brake ? -Math.sign(car.v) * 0.1 : dir * 0.05;
      car.v = Math.max(-car.top, Math.min(car.top, car.v));
      if (car.v) car.facing = Math.sign(car.v);
      if (!brake && Math.abs(car.v) > 1 && t % 6 === 0) puffs.push({ x: car.facing > 0 ? car.x - 2 : car.x + W, y: cv.height - 7, a: 0.9, r: 1.5 });
    }
    car.x += car.v;
    for (const p of puffs) { p.x -= car.facing * 0.3; p.y -= 0.2; p.a -= 0.02; p.r += 0.06; }
    while (puffs.length && puffs[0].a <= 0) puffs.shift();
    for (const p of puffs) { x.fillStyle = `rgba(150,150,150,${p.a.toFixed(2)})`; const s = Math.round(p.r) * 2; x.fillRect(Math.round(p.x), Math.round(p.y), s, s); }
    drawCar(car.x, cv.height - H - 2, car.facing, Math.abs(car.v) > 0.2 && Math.floor(t / Math.max(2, 8 - Math.abs(car.v) * 2)) % 2);
    raf = requestAnimationFrame(step);
  }

  window.daylogCar = {
    start(canvas) {
      if (raf) return;
      cv = canvas; x = cv.getContext('2d'); cv.hidden = false; resize();
      car.x = -W; pickTarget(); step();
    },
    stop() { cancelAnimationFrame(raf); raf = 0; if (cv) { x.clearRect(0, 0, cv.width, cv.height); cv.hidden = true; } }
  };
})();
