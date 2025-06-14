"use strict";
// CONFIG
/* -------- GAME MODES (added MOLE) -------- */
const MODES = {
  FISH:     'fish',
  EMOJI:    'emoji',
  BALLOONS: 'balloons',
  MOLE:     'mole'           // 🆕 whack-a-mole
};

// ----- Global defaults -----
const globalCfg = {
  mode: MODES.EMOJI,
  count: 6,
  rMin: 25,
  rMax: 90,
  vMin: 10,
  vMax: 180,
  spin: 25,
  burstN: 14,
  particleLife: 1,
};

// ----- Per game configuration -----
const modeCfgs = {
  [MODES.EMOJI]: {
    emojis: [
      '🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉','⭐','🥳','💎',
      '🍀','🌸','🍕','🍔','🍟','🍦','🍩','🍪','🍉','🍓','🍒','🍇','🧸','🎁','🎀','🪁',
      '🪀','🎨','🎧','🎮','🏀','⚾️','🏈','🎯','🚁','✈️','🦄','🐱','🐶','🐸','🐥','🐝','🦋',
      '🌈','🔥','💖','🍭','🍬','🧁','🎂','🍰','🥐','🍌','🍊','🥝','🛼','⛸️','🐰','🐼','🐨',
      '🐧','🐿️','🦊','🐢','🦖','🐯','🐮','🐷','🐹','🐭','💗','💝','😻','💞','🪅','🍿','🥤',
      '🧋','🌞','🌺','🌵','📸','⌚','🧸'
    ]
  },
  [MODES.FISH]: {
    fish: ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'],
    bubble: ['🫧']
  },
  [MODES.BALLOONS]: {
    brightMin: 0.9,   // 80 % – 120 % brightness
    brightMax: 2,
    satMin: 0.9,      // 80 % – 120 % saturation
    satMax: 1.0,
    bVMin: 25,        // balloon speed (vertical, vh /s)
    bVMax: 60,
    balloons: ['🎈'],
    balloonRare: ['☁️','🪁','🦋','⚡','🪙','⭐','🍂']
  },
  [MODES.MOLE]: {
    moleGridCols: 5,
    moleGridRows: 3,
    moleUpV:      350,   // px / s up / down
    moleStayMin:  1000,  // ms
    moleStayMax:  3000,
    moleCount:    12,    // concurrent moles
    animals: ['🐭','🐰']
  }
};

function buildCfg(mode) {
  return Object.assign({}, globalCfg, modeCfgs[mode] || {}, { mode });
}

let cfg = buildCfg(globalCfg.mode);

// DATA
const BURST   = ['✨', '💥', '💫'];
const moleHoles = [];      // board cells

/* ------ per-mode behaviour registry ------ */
const ModeHandlers = {};
function registerMode(name, handler) {
  ModeHandlers[name] = handler;
  return handler;
}


/* -----------------------------------------------------------
 * Base class for all game modes. Handles common sprite logic
 * like movement, generic boundary checks and collision hooks.
 * Individual games override the relevant methods.
 * --------------------------------------------------------- */
/* Expected interface:
 * spawn()            create new sprites
 * update(sprite, dt)
 * draw(sprite)
 * hit(sprite)
 * contains(sprite,x,y)
 * resolveCollisions()
 * setup() / cleanup()
 */
class GameMode {
  constructor(opts = {}) { this.opts = opts; }
  spawn() {}

  /** update sprite position */
  updateSpriteMovement(s, dt) {
    s.x += s.dx * dt;
    s.y += s.dy * dt;
  }

  /** remove sprites that move far off screen */
  checkOffscreen(s) {
    const W = winW, H = winH;
    if (
      s.x < -s.r * 2 ||
      s.x > W + s.r * 2 ||
      s.y < -s.r * 2 ||
      s.y > H + s.r * 2
    ) {
      s.alive = false;
    }
  }

  /** per-frame update */
  update(s, dt) {
    if (!s.alive) return;
    this.updateSpriteMovement(s, dt);
    this.checkOffscreen(s);
  }

  /** draw sprite. subclasses typically override */
  draw(_s) {}

  /** default hit behaviour */
  hit(s) { s.pop = 0.01; }

  contains(s, px, py) {
    return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2;
  }

  /* optional hooks */
  resolveCollisions() {}
  setup() {}
  cleanup() {}
}

const gameContainer = document.createElement('div');
gameContainer.id = 'game';

const gameScreen = document.getElementById('gameScreen');
gameScreen.appendChild(gameContainer);
const as = document.getElementById('teamAScore');
const bs = document.getElementById('teamBScore');
let winW = window.visualViewport.width || window.innerWidth;
let winH = window.visualViewport.height || window.innerHeight;

function onSpritePointerDown(e) {
  const target = e.target.closest('.emoji');
  if (!target || !target._sprite) return;
  const rect = gameContainer.getBoundingClientRect();
  doHit(
    e.clientX - rect.left,
    e.clientY - rect.top,
    e.button === 2 ? 'teamA' : 'teamB',
    target._sprite
  );
}

gameContainer.addEventListener('pointerdown', onSpritePointerDown);

window.addEventListener('resize', () => {
 winW = window.visualViewport.width || window.innerWidth;
 winH = window.visualViewport.height || window.innerHeight;
});

window.addEventListener('orientationchange', () => {
 winW = window.visualViewport.width || window.innerWidth;
 winH = window.visualViewport.height || window.innerHeight;
});


/* -------- Whack-a-Mole board builder -------- */
function buildMoleBoard (opts = cfg) {
  moleHoles.length = 0;

  Object.assign(gameContainer.style, {
    display: 'grid',
    gridTemplateColumns: `repeat(${opts.moleGridCols},1fr)`,
    gridTemplateRows: `repeat(${opts.moleGridRows},1fr)`
  });

  const total = opts.moleGridCols * opts.moleGridRows;
  for (let i = 0; i < total; ++i) {
    const cell = document.createElement('div');
    cell.className = 'moleHole';
    gameContainer.appendChild(cell);
    cell.dataset.busy = '';
    moleHoles.push(cell);
  }
}
// Utilities
const rand = n => Math.random() * n;
const between = (a, b) => a + rand(b - a);

// common helpers for spawn logic
const randRadius = () => between(cfg.rMin, cfg.rMax);
const randSpeed  = () => between(cfg.vMin, cfg.vMax);
const randX = r => between(r, winW - r);
const randY = r => between(r, winH - r);
const pick = arr => arr[Math.floor(rand(arr.length))];

// return a random velocity vector of given magnitude
const randVec = (speed = randSpeed()) => {
  const ang = rand(Math.PI * 2);
  return { dx: Math.cos(ang) * speed, dy: Math.sin(ang) * speed };
};


function applyTransform(el, x, y, rot, sx, sy) {
  // cache typed OM objects on the element so we don't recreate
  // them on every frame. When called the first time we create the
  // CSSTransformValue and reuse the individual components thereafter.
  let cache = el._tf;
  if (!cache) {
    const translate = new CSSTranslate(CSS.px(x), CSS.px(y));
    const rotate = new CSSRotate(CSS.rad(rot));
    const scale = new CSSScale(sx, sy);
    const tv = new CSSTransformValue([translate, rotate, scale]);
    el.attributeStyleMap.set('transform', tv);
    cache = el._tf = { translate, rotate, scale };
  } else {
    cache.translate.x.value = x;
    cache.translate.y.value = y;
    cache.rotate.angle.value = rot;
    cache.scale.x = sx;
    cache.scale.y = sy;
  }
}

// PARTICLE CLASS (DOM version)
class Particle {
  constructor(x, y, dx, dy, e) {
    const el = document.createElement('div');
    el.className = 'particle';
    el.textContent = e;
    Object.assign(el.style, {
      left: `${x}px`,
      top: `${y}px`
    });
    el.style.setProperty('--dx', `${dx}px`);
    el.style.setProperty('--dy', `${dy}px`);
    el.style.setProperty('--life', `${cfg.particleLife}s`);
    el.addEventListener('animationend', () => el.remove(), { once: true });
    gameContainer.appendChild(el);
    this.el = el;
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
    // set constant size once
    const size = this.r * 2;
    Object.assign(this.el.style, {
      width: `${size}px`,
      height: `${size}px`,
      lineHeight: `${size}px`,
      fontSize: `${size}px`
    });

    /* BALLOON – give it a permanent tint ONCE */
    if (this.mode === ModeHandlers[MODES.BALLOONS]) {
      const hue = Math.random() * 360;                    // 0–360°
      const bri = between(this.mode.opts.brightMin, this.mode.opts.brightMax);
      const sat = between(this.mode.opts.satMin, this.mode.opts.satMax);
      // this.el.style.filter =
     this.el.style.filter = 
       `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
    }

    gameContainer.appendChild(this.el);
    this.el._sprite = this;
    this.draw(); // initial position/size
  }

  reset() {
    const W = winW, H = winH;
    this.r = randRadius();
    const r = this.r;
    // update size on reset
    const size = r * 2;
    Object.assign(this.el.style, {
      width: `${size}px`,
      height: `${size}px`,
      lineHeight: `${size}px`,
      fontSize: `${size}px`
    });
    if (this.mode === ModeHandlers[MODES.FISH]) {
      // spawn from left or right edge
      const side = Math.random() < 0.5 ? 'left' : 'right';
      // x just off-screen
      this.x = side === 'left' ? -r : W + r;
      // y anywhere within vertical bounds
      this.y = randY(r);

      // horizontal velocity toward screen center
      this.dx = (side === 'left' ? 1 : -1) * randSpeed();
      // small vertical variance
      this.dy = between(-20, 20);

      // set face direction based on movement
      this.face = this.dx > 0 ? 1 : -1;
      // choose random fish sprite
      this.e = pick(this.mode.opts.fish);
      this.dir = -this.face;
    } else {
      this.x = randX(r);
      this.y = randY(r);
      const { dx, dy } = randVec();
      this.dx = dx;
      this.dy = dy;
    }
    this.pop = 0;
    this.alive = true;
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
class EmojiGame extends GameMode {
  spawn() {
    const r = randRadius();
    const e = pick(this.opts.emojis);
    const x = randX(r);
    const y = randY(r);
    const { dx, dy } = randVec();
    state.sprites.push(new Sprite({ x, y, dx, dy, r, e, face:1, dir:1 }));
  }
  update(s, dt) {
    this.updateSpriteMovement(s, dt);
    if (s.pop > 0) {
      s.pop += dt;
      if (s.pop > 0.25) s.alive = false;
    } else {
      const W = winW, H = winH;
      if ((s.x - s.r < 0 && s.dx < 0) || (s.x + s.r > W && s.dx > 0)) s.dx *= -1;
      if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
    }
    this.checkOffscreen(s);
  }
  draw(s) {
    if (!s.alive) return;
    let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
    const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
    applyTransform(s.el, s.x - s.r, s.y - s.r, rot, scale, scale);
  }
  resolveCollisions() {
    for (let i = 0; i < state.sprites.length; i++) {
      const a = state.sprites[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < state.sprites.length; j++) {
        const b = state.sprites[j];
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
}
registerMode(MODES.EMOJI, new EmojiGame(modeCfgs[MODES.EMOJI]));

class FishGame extends GameMode {
  spawn() {
    const r = randRadius();
    const face = Math.random() < 0.5 ? 1 : -1;
    const x = face === 1 ? -r : winW + r;
    const y = randY(r);
    const dx = face * randSpeed();
    const dy = between(-20, 20);
    const e = pick(this.opts.fish);
    const dir = -face;
    state.sprites.push(new Sprite({ x, y, dx, dy, r, e, face, dir }));
  }
  update(s, dt) {
    this.updateSpriteMovement(s, dt);
    if (s.pop > 0) {
      s.pop += dt;
      s.angle += dt * cfg.spin * s.dir;
      s.dx *= 1.25;
    } else {
      const H = winH;
      if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
    }
    this.checkOffscreen(s);
  }
  draw(s) {
    if (!s.alive) return;
    const rot = s.angle;
    const flip = s.face > 0 ? -1 : 1;
    applyTransform(s.el, s.x - s.r, s.y - s.r, rot, flip, 1);
  }
}
registerMode(MODES.FISH, new FishGame(modeCfgs[MODES.FISH]));

class BalloonGame extends GameMode {
  spawn() {
    const r = randRadius();
    const face = -1;
    const rare = Math.random() < 0.05;
    const e = rare ? pick(this.opts.balloonRare) : this.opts.balloons[0];
    const x = randX(r);
    const y = winH + r;
    const dx = between(-20, 20);
    const dy = -between(this.opts.bVMin, this.opts.bVMax);
    state.sprites.push(new Sprite({ x, y, dx, dy, r, e, face, dir:1 }));
  }
  update(s, dt) {
    this.updateSpriteMovement(s, dt);
    if (s.pop > 0) {
      s.pop += dt;
      if (s.pop > 0.25) s.alive = false;
    }
    this.checkOffscreen(s);
  }
  draw(s) {
    if (!s.alive) return;
    let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
    const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
    applyTransform(s.el, s.x - s.r, s.y - s.r, rot, scale, scale);
  }
}
registerMode(MODES.BALLOONS, new BalloonGame(modeCfgs[MODES.BALLOONS]));

class MoleGame extends GameMode {
  spawn() {
    if (state.sprites.length >= this.opts.moleCount) return;
    const freeHoles = moleHoles.filter(h => !h.dataset.busy);
    if (freeHoles.length === 0) return;
    const hole = pick(freeHoles);
    hole.dataset.busy = '1';
    const rect = hole.getBoundingClientRect();
    const r = Math.min(rect.width, rect.height) * 0.40;
    const x = rect.width * 0.5;
    const y = rect.height + r;
    const dx = 0;
    const dy = -this.opts.moleUpV;
    const e = pick(this.opts.animals);
    const s = new Sprite({ x, y, dx, dy, r, e, face:1, dir:1 });
    s.hole = hole;
    s.phase = 'up';
    s.timer = between(this.opts.moleStayMin, this.opts.moleStayMax) / 1000;
    s.el.remove();
    hole.appendChild(s.el);
    state.sprites.push(s);
  }
  update(s, dt) {
    if (s.phase) {
      // keep mole centered within its hole
      if (s.phase === 'up') {
        s.y += s.dy * dt;
        if (s.y <= s.r) { s.y = s.r; s.dy = 0; s.phase = 'stay'; }
      } else if (s.phase === 'stay') {
        s.timer -= dt;
        if (s.timer <= 0) { s.phase = 'down'; s.dy = this.opts.moleUpV; }
      } else if (s.phase === 'down') {
        s.y += s.dy * dt;
        const h = s.el.parentElement.clientHeight;
        if (s.y >= h + s.r) s.alive = false;
      }
      return;
    }
  }
  draw(s) {
    if (!s.alive) return;
    applyTransform(s.el, s.x - s.r, s.y - s.r, 0, 1, 1);
  }
  hit(s) {
    s.pop = 0.01;
    if (s.phase && s.phase !== 'down') {
      const game = gameContainer.getBoundingClientRect();
      const hole = s.el.parentElement.getBoundingClientRect();
      const gx = s.x + hole.left - game.left;
      const gy = s.y + hole.top - game.top;
      burst(gx, gy, ['💫']);
      s.phase = 'down';
      s.dy = this.opts.moleUpV;
      s.timer = 0;
    }
  }
  contains(s, px, py) {
    const game = gameContainer.getBoundingClientRect();
    const hole = s.el.parentElement.getBoundingClientRect();
    px -= hole.left - game.left;
    py -= hole.top - game.top;
    return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2;
  }
  setup() {
    cfg.count = this.opts.moleCount;
    buildMoleBoard(this.opts);
  }
  cleanup() {
    document.querySelectorAll('.moleHole').forEach(h => h.remove());
    gameContainer.style.display = 'block';
  }
}
registerMode(MODES.MOLE, new MoleGame(modeCfgs[MODES.MOLE]));

let currentMode = ModeHandlers[cfg.mode];

// ---------- Runtime State ----------
const state = {
  sprites: [],
  pending: 0,      // scheduled but not yet realised spawns
  scores: { teamA: 0, teamB: 0 }
};

const spawnTimers = [];

const DELAY = 3000;            // ms – max random delay per spawn

function scheduleSpawn() {
  state.pending++;
  const id = setTimeout(() => {
    spawn();
    state.pending--;
    const idx = spawnTimers.indexOf(id);
    if (idx !== -1) spawnTimers.splice(idx, 1);
  }, rand(DELAY));
  spawnTimers.push(id);
}

function clearSpawnTimers() {
  for (const t of spawnTimers) clearTimeout(t);
  spawnTimers.length = 0;
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
    const sp = 150 + rand(150);
    const { dx: dxp, dy: dyp } = randVec(sp);

    // clone the hidden burst template
    const b = burstTemplate.cloneNode(true);
    b.style.display = 'block';
    b.textContent = emojiArr[Math.floor(rand(emojiArr.length))];

    // position at impact point
    Object.assign(b.style, {
      left: `${x}px`,
      top: `${y}px`
    });

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
  for (let i = state.sprites.length - 1; i >= 0; i--) {
    if (!state.sprites[i].alive) {
      const sp = state.sprites[i];
      if (sp.mode === ModeHandlers[MODES.MOLE] && sp.hole) {
        sp.hole.dataset.busy = '';
      }
      sp.el.remove();
      state.sprites.splice(i, 1);
    }
  }
  // ensure count
  while (state.sprites.length + state.pending < cfg.count) scheduleSpawn();

}

// INITIAL SPAWN
for (let i = 0; i < cfg.count; i++) scheduleSpawn();

// ----- Score & Hit Logic -----

const cfgGame = App.Config.get();
as.className = cfgGame.teamA;
bs.className = cfgGame.teamB;
updateScore();

function updateScore() {
  as.textContent = `${state.scores.teamA}`;
  bs.textContent = `${state.scores.teamB}`;
}

function setTeams(a, b) {
  as.className = a;
  bs.className = b;
}

function calculatePoints(sprite) {
  // Smaller & faster ⇒ larger score; Bigger & slower ⇒ smaller score
  const speed = Math.hypot(sprite.dx, sprite.dy);
  const sizeRatio = cfg.rMax / sprite.r;    // ≤ 1 for biggest, ≥ 1 for smallest
  const speedRatio = speed / cfg.vMax;       // 0 … 1
  // scale – tweak 400 to taste
  return Math.max(10, Math.round(sizeRatio * speedRatio * 400));
}

function doHit(px, py, team, sprite) {
  // move the single ripple element
  Object.assign(ripple.style, {
    left: `${px}px`,
    top: `${py}px`
  });
  // restart the animation
  ripple.classList.remove('animate');
  void ripple.offsetWidth;          // force reflow
  ripple.classList.add('animate');

  const targets = sprite ? [sprite] : state.sprites;
  for (const s of targets) {
    if (s.alive && (!sprite ? s.contains(px, py) : true) && s.pop === 0) {
      s.doHit();

      // points depend on sprite size & speed
      state.scores[team] += calculatePoints(s);
      updateScore();

      if (currentMode === ModeHandlers[MODES.EMOJI] || currentMode === ModeHandlers[MODES.BALLOONS]) {
        burst(s.x, s.y); // normal emoji burst
      } else if (currentMode === ModeHandlers[MODES.FISH]) {
        burst(s.x, s.y, currentMode.opts.bubble); // fish bubble burst
      }
      break;
    }
  }
}

// INPUT
function preventContextMenu(e) { e.preventDefault(); }
function addInputListeners() {
  window.addEventListener('contextmenu', preventContextMenu);
}
function removeInputListeners() {
  window.removeEventListener('contextmenu', preventContextMenu);
}
addInputListeners();

// MAIN LOOP
let last = performance.now();
function loop(now) {
  const dt = (now - last) / 1000;
  last = now;

  state.sprites.forEach(s => s.update(dt));
  if (currentMode && currentMode.resolveCollisions) currentMode.resolveCollisions();
  maintain();
  state.sprites.forEach(s => s.draw());

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);


// MODE TOGGLE
function setMode(m) {
  if (currentMode && currentMode.cleanup) currentMode.cleanup();
  removeInputListeners();
  cfg = buildCfg(m);
  Game.cfg = cfg;
  currentMode = ModeHandlers[m];

  state.sprites.forEach(s => s.el.remove());
  state.sprites.length = 0;
  clearSpawnTimers();
  state.pending = 0;

  if (currentMode && currentMode.setup) currentMode.setup();

  addInputListeners();

  for (let i = 0; i < cfg.count; i++) scheduleSpawn();
}

const Game = {
  MODES,
  modeCfgs,
  globalCfg,
  cfg,
  state,
  utils: { rand, between, applyTransform },
  setTeams,
  setMode,
  spawn,
  burst
};

window.Game = Game;
