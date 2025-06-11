// CONFIG
/* -------- GAME MODES (added MOLE) -------- */
const MODES = {
  FISH:     'fish',
  EMOJI:    'emoji',
  BALLOONS: 'balloons',
  MOLE:     'mole'           // 🆕 whack-a-mole
};
const cfg = {
  mode: MODES.EMOJI,
  count: 6,
  rMin: 25,
  rMax: 90,
  vMin: 10,
  vMax: 180,
  spin: 25,
  burstN: 14,
};

// keep the initial defaults so modes can override and restore them
const baseCfg = { ...cfg };

// DATA
const EMOJIS =  ['🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉', '⭐', '🥳', '💎', '🍀', '🌸', '🍕', '🍔', '🍟', '🍦', '🍩', '🍪', '🍉', '🍓', '🍒', '🍇', '🧸', '🎁', '🎀', '🪁', '🪀', '🎨', '🎧', '🎮', '🏀', '⚾️', '🏈', '🎯', '🚁', '✈️', '🦄', '🐱', '🐶', '🐸', '🐥', '🐝', '🦋', '🌈', '🔥', '💖',  '🍭', '🍬', '🧁', '🎂', '🍰', '🥐', '🍌', '🍊', '🥝','🛼', '⛸️',  '🐰', '🐼', '🐨', '🐧', '🐿️', '🦊', '🐢', '🦖', '🐯', '🐮', '🐷',  '🐹', '🐭',  '💗', '💝', '😻', '💞',  '🪅',  '🍿', '🥤', '🧋',  '🌞', '🌺', '🌵',  '📸', '⌚', '🧸'];
const FISH    = ['🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🦈', '🐙', '🪼','🦀','🦞','🦐'];
const BURST   = ['✨', '💥', '💫'];
const BUBBLE  = ['🫧']; // used for fish‑mode bubble burst
const BALLOON = ['🎈'];
const BALLOON_RARE = ['☁️', '🪁', '🦋','⚡','🪙','⭐','🍂'];
const MOLE_ANIMALS = ['🐭','🐰'];
const moleHoles = [];      // board cells

/* ------ per-mode behaviour registry ------ */
const ModeHandlers = {};
// optional per-mode default overrides (count, speed, etc.)
const ModeDefaults = {};
ModeDefaults[MODES.EMOJI] = { count: 6 };
ModeDefaults[MODES.FISH] = { count: 6, vMin: 80, vMax: 220 };
ModeDefaults[MODES.BALLOONS] = {
  count: 6,
  brightMin: 0.9,
  brightMax: 2,
  satMin: 0.9,
  satMax: 1.0,
  bVMin: 25,
  bVMax: 60,
};
ModeDefaults[MODES.MOLE] = {
  count: 12,
  moleGridCols: 5,
  moleGridRows: 3,
  moleUpV: 350,
  moleStayMin: 1000,
  moleStayMax: 3000,
};

const gameContainer = document.createElement('div');
gameContainer.id = 'game';
Object.assign(gameContainer.style, {
  position: 'relative',
  width: '100vw',
  height: '100vh',
  overflow: 'hidden',
  margin: '0',
  padding: '0',
});

document.getElementById('gameScreen').appendChild(gameContainer);
let winW = window.visualViewport.width || window.innerWidth;
let winH = window.visualViewport.height || window.innerHeight;

window.addEventListener('resize', () => {
 winW = window.visualViewport.width || window.innerWidth;
 winH = window.visualViewport.height || window.innerHeight;
});

window.addEventListener('orientationchange', () => {
 winW = window.visualViewport.width || window.innerWidth;
 winH = window.visualViewport.height || window.innerHeight;
});


/* -------- Whack-a-Mole board builder -------- */
function buildMoleBoard () {
  moleHoles.length = 0;

  gameContainer.style.display             = 'grid';
  gameContainer.style.gridTemplateColumns = `repeat(${cfg.moleGridCols},1fr)`;
  gameContainer.style.gridTemplateRows    = `repeat(${cfg.moleGridRows},1fr)`;

  const total = cfg.moleGridCols * cfg.moleGridRows;
  for (let i = 0; i < total; ++i) {
    const cell = document.createElement('div');
    cell.className = 'moleHole';
    Object.assign(cell.style, {
      position:       'relative',
      overflow:       'hidden',     /* crops the mole sprite */
      display:        'flex',
      alignItems:     'flex-end',
      justifyContent: 'center',
      pointerEvents:  'none'
   });
    const hole = document.createElement('div');
    hole.textContent = '🕳️';
    hole.style.fontSize = '30vh';
    hole.style.lineHeight = '27vh';
    hole.style.pointerEvents = 'none';
    cell.appendChild(hole);
    gameContainer.appendChild(cell);
    moleHoles.push(cell);
  }
}
// Utilities
const rand = n => Math.random() * n;
const between = (a, b) => a + rand(b - a);

// PARTICLE CLASS (DOM version)
class Particle {
  constructor(x, y, dx, dy, e) {
    this.x = x; this.y = y;
    this.dx = dx; this.dy = dy;
    this.e = e; this.t = 0;

    this.el = document.createElement('div');
    this.el.className = 'particle';
    this.el.textContent = e;
    Object.assign(this.el.style, {
      position: 'absolute',
      willChange: 'transform, opacity',
      fontFamily: 'sans-serif',
      fontSize: '24px',
      textAlign: 'center',
      lineHeight: '1',
      pointerEvents: 'none',
      userSelect: 'none',
      transformOrigin: 'center',
    });
    gameContainer.appendChild(this.el);
  }

  update(dt) {
    this.x += this.dx * dt;
    this.y += this.dy * dt;
    this.t += dt;
  }

  draw() {
    if (this.t > cfg.particleLife) return;
    const alpha = 1 - this.t / cfg.particleLife;
    this.el.style.opacity = alpha;
    this.el.style.transform = `translate3d(${this.x}px,${this.y}px,0)`;
  }
}

// SPRITE CLASS (DOM version)
class Sprite {
  constructor({ x, y, dx, dy, r, e, face, dir }) {
    this.x = x; this.y = y;
    this.dx = dx; this.dy = dy;
    this.r = r; this.e = e;
    this.face = face; this.dir = dir;
    this.mass = r * r;
    this.pop = 0;
    this.alive = true;
    this.angle = 0;
    this.mode = currentMode;

    this.el = document.createElement('div');
    this.el.className = 'emoji';
    this.el.textContent = e;
    Object.assign(this.el.style, {
      position: 'absolute',
      willChange: 'transform, opacity',
      fontFamily: 'sans-serif',
      textAlign: 'center',
      lineHeight: '1',
      pointerEvents: 'none',
      userSelect: 'none',
      transformOrigin: 'center',
      display: 'flex',
      justifyContent: 'center',
      alignItems: 'center',
    });
    // set constant size once
    const size = this.r * 2;
    this.el.style.width = `${size}px`;
    this.el.style.height = `${size}px`;
    this.el.style.lineHeight = `${size}px`;
    this.el.style.fontSize = `${size}px`;

    gameContainer.appendChild(this.el);
    this.draw(); // initial position/size
  }

  update(dt) {
    if (this.mode && this.mode.update) this.mode.update(this, dt);
  }

  draw() {
    if (this.mode && this.mode.draw) this.mode.draw(this);
  }

  doHit() {
    if (this.mode && this.mode.hit) this.mode.hit(this);
  }

  contains(px, py) {
    if (this.mode && this.mode.contains) return this.mode.contains(this, px, py);
    return false;
  }
}

/* ---------- Mode behaviour implementations ---------- */
ModeHandlers[MODES.EMOJI] = {
  spawn() {
    const r = between(cfg.rMin, cfg.rMax);
    const e = EMOJIS[Math.floor(rand(EMOJIS.length))];
    const x = between(r, winW - r);
    const y = between(r, winH - r);
    const ang = rand(Math.PI * 2);
    const v = between(cfg.vMin, cfg.vMax);
    const dx = Math.cos(ang) * v;
    const dy = Math.sin(ang) * v;
    sprites.push(new Sprite({ x, y, dx, dy, r, e, face:1, dir:1 }));
  },
  update(s, dt) {
    if (!s.alive) return;
    s.x += s.dx * dt;
    s.y += s.dy * dt;
    if (s.pop > 0) {
      s.pop += dt;
      if (s.pop > 0.25) s.alive = false;
    } else {
      const W = winW, H = winH;
      if ((s.x - s.r < 0 && s.dx < 0) || (s.x + s.r > W && s.dx > 0)) s.dx *= -1;
      if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
    }
    const W = winW, H = winH;
    if (s.x < -s.r * 2 || s.x > W + s.r * 2 || s.y < -s.r * 2 || s.y > H + s.r * 2) s.alive = false;
  },
  draw(s) {
    if (!s.alive) return;
    let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
    const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
    s.el.style.setProperty('--x', `${s.x - s.r}px`);
    s.el.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.style.setProperty('--rot', `${rot}rad`);
    s.el.style.setProperty('--sx', `${scale}`);
    s.el.style.setProperty('--sy', `${scale}`);
  },
  hit(s) {
    s.pop = 0.01;
    burst(s.x, s.y);
  },
  contains(s, px, py) { return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2; },
  resolveCollisions() {
    for (let i = 0; i < sprites.length; i++) {
      const a = sprites[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < sprites.length; j++) {
        const b = sprites[j];
        if (!b.alive) continue;
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy), min = a.r + b.r;
        if (dist === 0 || dist >= min) continue;
        const nx = dx / dist, ny = dy / dist;
        const overlap = min - dist;
        const tot = a.mass + b.mass;
        a.x -= nx * overlap * (b.mass / tot);
        a.y -= ny * overlap * (b.mass / tot);
        b.x += nx * overlap * (a.mass / tot);
        b.y += ny * overlap * (a.mass / tot);
        const rvx = b.dx - a.dx, rvy = b.dy - a.dy;
        const rel = rvx * nx + rvy * ny;
        if (rel > 0) continue;
        const impulse = -(1 + 1) * rel / (1 / a.mass + 1 / b.mass);
        const ix = impulse * nx, iy = impulse * ny;
        a.dx -= ix / a.mass; a.dy -= iy / a.mass;
        b.dx += ix / b.mass; b.dy += iy / b.mass;
      }
    }
  }
};

ModeHandlers[MODES.FISH] = {
  spawn() {
    const r = between(cfg.rMin, cfg.rMax);
    const face = Math.random() < 0.5 ? 1 : -1;
    const x = face === 1 ? -r : winW + r;
    const y = between(r, winH - r);
    const dx = face * between(cfg.vMin, cfg.vMax);
    const dy = between(-20, 20);
    const e = FISH[Math.floor(rand(FISH.length))];
    const dir = -face;
    sprites.push(new Sprite({ x, y, dx, dy, r, e, face, dir }));
  },
  update(s, dt) {
    if (!s.alive) return;
    s.x += s.dx * dt;
    s.y += s.dy * dt;
    if (s.pop > 0) {
      s.pop += dt;
      s.angle += dt * cfg.spin * s.dir;
      s.dx *= 1.25;
    } else {
      const H = winH;
      if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
    }
    const W = winW, H = winH;
    if (s.x < -s.r * 2 || s.x > W + s.r * 2 || s.y < -s.r * 2 || s.y > H + s.r * 2) s.alive = false;
  },
  draw(s) {
    if (!s.alive) return;
    const rot = s.angle;
    const flip = s.face > 0 ? -1 : 1;
    s.el.style.setProperty('--x', `${s.x - s.r}px`);
    s.el.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.style.setProperty('--rot', `${rot}rad`);
    s.el.style.setProperty('--sx', `${flip}`);
    s.el.style.setProperty('--sy', `1`);
  },
  hit(s) {
    s.pop = 0.01;
    burst(s.x, s.y, BUBBLE);
  },
  contains(s, px, py) { return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2; }
};

ModeHandlers[MODES.BALLOONS] = {
  spawn() {
    const r = between(cfg.rMin, cfg.rMax);
    const face = -1;
    const rare = Math.random() < 0.05;
    const e = rare ? BALLOON_RARE[Math.floor(rand(BALLOON_RARE.length))] : BALLOON[0];
    const x = between(r, winW - r);
    const y = winH + r;
    const dx = between(-20, 20);
    const dy = -between(cfg.bVMin, cfg.bVMax);
    const s = new Sprite({ x, y, dx, dy, r, e, face, dir:1 });
    const hue = Math.random() * 360;
    const bri = between(cfg.brightMin, cfg.brightMax);
    const sat = between(cfg.satMin, cfg.satMax);
    s.el.style.filter = `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
    sprites.push(s);
  },
  update(s, dt) {
    if (!s.alive) return;
    s.x += s.dx * dt;
    s.y += s.dy * dt;
    if (s.pop > 0) {
      s.pop += dt;
      if (s.pop > 0.25) s.alive = false;
    }
    const W = winW, H = winH;
    if (s.x < -s.r * 2 || s.x > W + s.r * 2 || s.y < -s.r * 2 || s.y > H + s.r * 2) s.alive = false;
  },
  draw(s) {
    if (!s.alive) return;
    let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
    const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
    s.el.style.setProperty('--x', `${s.x - s.r}px`);
    s.el.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.style.setProperty('--rot', `${rot}rad`);
    s.el.style.setProperty('--sx', `${scale}`);
    s.el.style.setProperty('--sy', `${scale}`);
  },
  hit(s) {
    s.pop = 0.01;
    burst(s.x, s.y);
  },
  contains(s, px, py) { return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2; }
};

ModeHandlers[MODES.MOLE] = {
  spawn() {
    if (sprites.length >= cfg.count) return;
    const hole = moleHoles[Math.floor(rand(moleHoles.length))];
    const rect = hole.getBoundingClientRect();
    const r = Math.min(rect.width, rect.height) * 0.40;
    const x = rect.width * 0.5;
    const y = rect.height + r;
    const dx = 0;
    const dy = -cfg.moleUpV;
    const e = MOLE_ANIMALS[Math.floor(rand(MOLE_ANIMALS.length))];
    const s = new Sprite({ x, y, dx, dy, r, e, face:1, dir:1 });
    s.phase = 'up';
    s.timer = between(cfg.moleStayMin, cfg.moleStayMax) / 1000;
    s.el.remove();
    hole.appendChild(s.el);
    sprites.push(s);
  },
  update(s, dt) {
    if (s.phase) {
      if (s.phase === 'up') {
        s.y += s.dy * dt;
        if (s.y <= s.r) { s.y = s.r; s.dy = 0; s.phase = 'stay'; }
      } else if (s.phase === 'stay') {
        s.timer -= dt;
        if (s.timer <= 0) { s.phase = 'down'; s.dy = cfg.moleUpV; }
      } else if (s.phase === 'down') {
        s.y += s.dy * dt;
        const h = s.el.parentElement.clientHeight;
        if (s.y >= h + s.r) s.alive = false;
      }
      return;
    }
  },
  draw(s) {
    if (!s.alive) return;
    s.el.style.setProperty('--x', `${s.x - s.r}px`);
    s.el.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.style.setProperty('--rot', `0rad`);
    s.el.style.setProperty('--sx', `1`);
    s.el.style.setProperty('--sy', `1`);
  },
  hit(s) {
    s.pop = 0.01;
    if (s.phase && s.phase !== 'down') {
      const game = gameContainer.getBoundingClientRect();
      const hole = s.el.parentElement.getBoundingClientRect();
      const gx = s.x + hole.left - game.left;
      const gy = s.y + hole.top - game.top;
      burst(gx, gy, ['💫']);
      s.phase = 'down';
      s.dy = cfg.moleUpV;
      s.timer = 0;
    }
  },
  contains(s, px, py) {
    const game = gameContainer.getBoundingClientRect();
    const hole = s.el.parentElement.getBoundingClientRect();
    px -= hole.left - game.left;
    py -= hole.top - game.top;
    return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2;
  },
  setup() {
    buildMoleBoard();
  },
  cleanup() {
    document.querySelectorAll('.moleHole').forEach(h => h.remove());
    gameContainer.style.display = 'block';
  }
};

let currentMode = ModeHandlers[cfg.mode];

// GAME STATE
const sprites = [];
const parts = [];
let pending = 0;              // scheduled but not yet realised spawns
const timers = [];            // active spawn timers

const DELAY = 3000;            // ms – max random delay per spawn

function scheduleSpawn() {
  pending++;
  const id = setTimeout(() => {
    timers.splice(timers.indexOf(id), 1);
    spawn();
    pending--;
  }, rand(DELAY));
  timers.push(id);
}
// SPAWN & BURST
function spawn() {
  if (currentMode && currentMode.spawn) currentMode.spawn();
}

// Create a hidden template for bursts
const burstTemplate = document.createElement('div');
burstTemplate.className = 'burst';
burstTemplate.style.display = 'none';
gameContainer.appendChild(burstTemplate);

// Flexible burst helper – defaults to EMOJI burst list, can be overridden
function burst(x, y, emojiArr = BURST) {
  for (let i = 0; i < cfg.burstN; i++) {
    const ang = rand(Math.PI * 2);
    const sp = 150 + rand(150);
    const dxp = Math.cos(ang) * sp;
    const dyp = Math.sin(ang) * sp;

    // clone the hidden burst template
    const b = burstTemplate.cloneNode(true);
    b.style.display = 'block';
    b.textContent = emojiArr[Math.floor(rand(emojiArr.length))];

    // position at impact point
    b.style.left = `${x}px`;
    b.style.top = `${y}px`;

    // pass velocity via CSS vars
    b.style.setProperty('--dx', `${dxp}px`);
    b.style.setProperty('--dy', `${dyp}px`);

    gameContainer.appendChild(b);
    // auto-cleanup after animation
    b.addEventListener('animationend', () => b.remove(), { once: true });
  }
}

// ripple effect element
const ripple = document.createElement('div');
ripple.classList.add('ripple');
gameContainer.appendChild(ripple);

// MAINTAIN
function maintain() {
  // remove dead sprites
  for (let i = sprites.length - 1; i >= 0; i--) {
    if (!sprites[i].alive) {
      sprites[i].el.remove();
      sprites.splice(i, 1);
    }
  }
  // ensure count
  while (sprites.length + pending < cfg.count) scheduleSpawn();

  // remove old particles
  for (let i = parts.length - 1; i >= 0; i--) {
    if (parts[i].t > cfg.particleLife) {
      parts[i].el.remove();
      parts.splice(i, 1);
    }
  }
}

// INITIAL SPAWN
for (let i = 0; i < cfg.count; i++) scheduleSpawn();

// SCORE & HIT LOGIC
let scores = { teamA: 0, teamB: 0 };
const as = document.getElementById('teamAScore');
const bs = document.getElementById('teamBScore');
as.className = params.teamA;
bs.className = params.teamB;

function updateScore() {
  as.textContent = `${scores.teamA}`;
  bs.textContent = `${scores.teamB}`;
}

function calculatePoints(sprite) {
  // Smaller & faster ⇒ larger score; Bigger & slower ⇒ smaller score
  const speed = Math.hypot(sprite.dx, sprite.dy);
  const sizeRatio = cfg.rMax / sprite.r;    // ≤ 1 for biggest, ≥ 1 for smallest
  const speedRatio = speed / cfg.vMax;       // 0 … 1
  // scale – tweak 400 to taste
  return Math.max(10, Math.round(sizeRatio * speedRatio * 400));
}

function doHit(px, py, team) {
  // move the single ripple element
  ripple.style.left = `${px}px`;
  ripple.style.top  = `${py}px`;
  // restart the animation
  ripple.classList.remove('animate');
  void ripple.offsetWidth;          // force reflow
  ripple.classList.add('animate');

  for (const s of sprites) {
    if (s.alive && s.contains(px, py) && s.pop === 0) {
      s.doHit();

      // points depend on sprite size & speed
      scores[team] += calculatePoints(s);
      updateScore();

      // each mode handles its own burst effects
      break;
    }
  }
}

// INPUT
gameContainer.addEventListener('pointerdown', e => {
  const rect = gameContainer.getBoundingClientRect();
  doHit(
    e.clientX - rect.left,
    e.clientY - rect.top,
    e.button === 2 ? 'teamA' : 'teamB'
  );
},{passive:true});
window.addEventListener('contextmenu', e => e.preventDefault());

// MAIN LOOP
let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;

  sprites.forEach(s => s.update(dt));
  parts.forEach(p => p.update(dt));
  if (currentMode && currentMode.resolveCollisions) currentMode.resolveCollisions();
  maintain();
  sprites.forEach(s => s.draw());
  parts.forEach(p => p.draw());

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);


// MODE TOGGLE
function setMode(m) {
  if (currentMode && currentMode.cleanup) currentMode.cleanup();

  // restore defaults then apply per-mode overrides
  Object.assign(cfg, baseCfg, ModeDefaults[m] || {});
  cfg.mode = m;
  currentMode = ModeHandlers[m];

  sprites.forEach(s => s.el.remove());
  sprites.length = 0;
  timers.forEach(clearTimeout);
  timers.length = 0;
  pending = 0;

  if (currentMode && currentMode.setup) currentMode.setup();

  for (let i = 0; i < cfg.count; i++) scheduleSpawn();
}
