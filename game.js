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
  // balloon colour ranges
  brightMin: 0.9,   // 80 % – 120 % brightness
  brightMax: 2,
  satMin: 0.9,   // 80 % – 120 % saturation
  satMax: 1.0,

  // balloon speed (vertical, vh /s)
  bVMin: 25,
  bVMax: 60,


  /* whack-a-mole */
  moleGridCols: 5,
  moleGridRows: 3,
  moleUpV:      350,   // px / s up / down
  moleStayMin:  1000,   // ms
  moleStayMax:  3000,
  moleCount:    12,     // concurrent moles
};

// DATA
const EMOJIS =  ['🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉', '⭐', '🥳', '💎', '🍀', '🌸', '🍕', '🍔', '🍟', '🍦', '🍩', '🍪', '🍉', '🍓', '🍒', '🍇', '🧸', '🎁', '🎀', '🪁', '🪀', '🎨', '🎧', '🎮', '🏀', '⚾️', '🏈', '🎯', '🚁', '✈️', '🦄', '🐱', '🐶', '🐸', '🐥', '🐝', '🦋', '🌈', '🔥', '💖',  '🍭', '🍬', '🧁', '🎂', '🍰', '🥐', '🍌', '🍊', '🥝','🛼', '⛸️',  '🐰', '🐼', '🐨', '🐧', '🐿️', '🦊', '🐢', '🦖', '🐯', '🐮', '🐷',  '🐹', '🐭',  '💗', '💝', '😻', '💞',  '🪅',  '🍿', '🥤', '🧋',  '🌞', '🌺', '🌵',  '📸', '⌚', '🧸'];
const FISH    = ['🐳', '🐋', '🐬', '🦭', '🐟', '🐠', '🦈', '🐙', '🪼','🦀','🦞','🦐'];
const BURST   = ['✨', '💥', '💫'];
const BUBBLE  = ['🫧']; // used for fish‑mode bubble burst
const BALLOON = ['🎈'];
const BALLOON_RARE = ['☁️', '🪁', '🦋','⚡','🪙','⭐','🍂'];
const MOLE_ANIMALS = ['🐭','🐰'];
const moleHoles = [];      // board cells

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

    /* BALLOON – give it a permanent tint ONCE */
    if (cfg.mode === MODES.BALLOONS) {
      const hue = Math.random() * 360;                    // 0–360°
      const bri = between(cfg.brightMin, cfg.brightMax);  // 0.8–1.2
      const sat = between(cfg.satMin, cfg.satMax);     // 0.8–1.2
      // this.el.style.filter =
     this.el.style.filter = 
       `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
    }

    gameContainer.appendChild(this.el);
    this.draw(); // initial position/size
  }

  reset() {
    const W = winW, H = winH;
    this.r = between(cfg.rMin, cfg.rMax);
    // update size on reset
    const size = this.r * 2;
    this.el.style.width = `${size}px`;
    this.el.style.height = `${size}px`;
    this.el.style.lineHeight = `${size}px`;
    this.el.style.fontSize = `${size}px`;
    if (cfg.mode === MODES.FISH) {
      // spawn from left or right edge
      const side = Math.random() < 0.5 ? 'left' : 'right';
      // x just off-screen
      x = side === 'left' ? -r : winW + r;
      // y anywhere within vertical bounds
      y = between(r, winH - r);

      // horizontal velocity toward screen center
      dx = (side === 'left' ? 1 : -1) * between(cfg.vMin, cfg.vMax);
      // small vertical variance
      dy = between(-20, 20);

      // set face direction based on movement
      face = dx > 0 ? 1 : -1;
      // choose random fish sprite
      e = FISH[Math.floor(rand(FISH.length))];
      dir = -face;
    } else {
      this.x = between(this.r, W - this.r);
      this.y = between(this.r, H - this.r);
      const ang = rand(Math.PI * 2);
      const v = between(cfg.vMin, cfg.vMax);
      this.dx = Math.cos(ang) * v;
      this.dy = Math.sin(ang) * v;
    }
    this.pop = 0;
    this.alive = true;
  }

  update(dt) {

    
    /* ------- Whack-a-Mole behaviour ------- */
    if (cfg.mode === MODES.MOLE && this.phase) {
      if (this.phase === 'up') {
        this.y += this.dy * dt;
        if (this.y <= this.r) {          // fully risen
          this.y = this.r;
          this.dy = 0;
          this.phase = 'stay';
       }
      } else if (this.phase === 'stay') {
        this.timer -= dt;
        if (this.timer <= 0) {
          this.phase = 'down';
          this.dy    = cfg.moleUpV;
        }
     } else if (this.phase === 'down') {
        this.y += this.dy * dt;
        const h = this.el.parentElement.clientHeight;
        if (this.y >= h + this.r) this.alive = false;
      }
      return;
    }

    if (!this.alive) return;

    this.x += this.dx * dt;
    this.y += this.dy * dt;

    if (this.pop > 0) {
      this.pop += dt;
      if (cfg.mode === MODES.FISH) {
        this.angle += dt * cfg.spin * this.dir;
        this.dx *= 1.25;
      }
      if ((cfg.mode === MODES.EMOJI || cfg.mode === MODES.BALLOONS) && this.pop > 0.25) {
        this.alive = false;
      }
    } else {
      // wall bounces
      const W = winW, H = winH;
      if (cfg.mode === MODES.EMOJI) {
        if ((this.x - this.r < 0 && this.dx < 0) || (this.x + this.r > W && this.dx > 0)) this.dx *= -1;
        if ((this.y - this.r < 0 && this.dy < 0) || (this.y + this.r > H && this.dy > 0)) this.dy *= -1;
      }
      if (cfg.mode === MODES.FISH) {
        if ((this.y - this.r < 0 && this.dy < 0) || (this.y + this.r > H && this.dy > 0)) this.dy *= -1;
      }
    }

    // out‑of‑bounds kill
    const W = winW, H = winH;
    if (this.x < -this.r * 2 || this.x > W + this.r * 2 || this.y < -this.r * 2 || this.y > H + this.r * 2) {
      this.alive = false;
    }
  }

  draw() {
    if (!this.alive) return;

        if (cfg.mode === MODES.MOLE && this.phase) {
      this.el.style.setProperty('--x', `${this.x - this.r}px`);
      this.el.style.setProperty('--y', `${this.y - this.r}px`);
      this.el.style.setProperty('--rot', `0rad`);
      this.el.style.setProperty('--sx', `1`);
      this.el.style.setProperty('--sy', `1`);
      return;
    }
    // this.el.style.border       = '1px dashed red';
    // this.el.style.borderRadius = '50%';

    // compute scale and rotation
    let scale = 1;
    if (cfg.mode === MODES.EMOJI && this.pop > 0) {
      scale = Math.max(0.01, 1 - this.pop * 4);
    }
    const rotation = cfg.mode === MODES.FISH
      ? this.angle
      : Math.sin((this.x + this.y) * 0.03) * 0.10;
    const flip = (cfg.mode === MODES.FISH && this.face > 0) ? -1 : 1;

    // only update transform each frame
    // Update only the CSS custom properties each frame:
    this.el.style.setProperty('--x', `${this.x - this.r}px`);
    this.el.style.setProperty('--y', `${this.y - this.r}px`);
    this.el.style.setProperty('--rot', `${rotation}rad`);
    this.el.style.setProperty('--sx', `${flip * scale}`);
    this.el.style.setProperty('--sy', `${scale}`);
  }

  doHit() {
    this.pop = 0.01;

        /* Whack-a-Mole hit */
    if (cfg.mode === MODES.MOLE && this.phase && this.phase !== 'down') {
      const game = gameContainer.getBoundingClientRect();
      const hole = this.el.parentElement.getBoundingClientRect();
      const gx   = this.x + hole.left - game.left;
      const gy   = this.y + hole.top  - game.top;
      burst(gx, gy, ['💫']);           // vertigo stars
      this.phase = 'down';
      this.dy    = cfg.moleUpV;
      this.timer = 0;                  // ⬅ cancel any remaining stay time
      return;
    }
  }

  contains(px, py) {
      /* When the sprite is sitting in a mole-hole its own (x, y)
     are relative to that hole, but the click we receive is
     relative to the whole game container.  Re-map once: */
  if (cfg.mode === MODES.MOLE) {
    const game = gameContainer.getBoundingClientRect();
    const hole = this.el.parentElement.getBoundingClientRect();
    px -= hole.left - game.left;
    py -= hole.top  - game.top;
  }
    return (px - this.x) ** 2 + (py - this.y) ** 2 <= this.r ** 2;
  }
}

// COLLISION RESOLUTION (Emoji mode)
function resolveCollisions() {
  if (cfg.mode !== MODES.EMOJI) return;
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

// GAME STATE
const sprites = [];
const parts = [];
let pending = 0;              // scheduled but not yet realised spawns

const DELAY = 3000;            // ms – max random delay per spawn

function scheduleSpawn() {
  pending++;
  setTimeout(() => {
    spawn();
    pending--;
  }, rand(DELAY));
}
// SPAWN & BURST
function spawn() {
  const r = between(cfg.rMin, cfg.rMax);
  let x, y, dx, dy, e, face = 1, dir = 1;

  if (cfg.mode === MODES.FISH) {
    // decide entry side & direction: face=1 → move right; face=-1 → move left
    face = Math.random() < 0.5 ? 1 : -1;

    // spawn just off-screen on that side
    x = face === 1
      ? -r               // left edge
      : winW + r;  // right edge

    // random vertical spawn anywhere in view
    y = between(r, winH - r);

    // horizontal speed toward the opposite side
    dx = face * between(cfg.vMin, cfg.vMax);

    // optional vertical “wobble” as before
    dy = between(-20, 20);

    e = FISH[Math.floor(rand(FISH.length))];
    dir = -face;
  } else if (cfg.mode === MODES.BALLOONS) {
    // vertical float: bottom → top
    face = -1;                                    // direction multiplier (-y)
    const rare = Math.random() < 0.05;            // 5 % chance of rare object
    e = rare ? BALLOON_RARE[Math.floor(rand(BALLOON_RARE.length))]
      : BALLOON[0];

    // horizontal start anywhere, just off the bottom edge
    x = between(r, winW - r);
    y = winH + r;

    // vertical speed (negative => upward), small sideways drift
    dx = between(-20, 20);
    dy = -between(cfg.bVMin, cfg.bVMax);

    dir = 1;  // not used by balloons but keeps struct intact
  } 
     else if (cfg.mode === MODES.MOLE) {
    if (sprites.length >= cfg.moleCount) return;   // limit concurrent moles

    const hole = moleHoles[Math.floor(rand(moleHoles.length))];
 const rect = hole.getBoundingClientRect();
 const r    = Math.min(rect.width, rect.height) * 0.40; // ⬅ 45 % of cell

 x = rect.width  * 0.5;        // centre horizontally
 y = rect.height + r;          // hide just below the hole, will rise up
    dx = 0;
    dy = -cfg.moleUpV;
    e  = MOLE_ANIMALS[Math.floor(rand(MOLE_ANIMALS.length))];

    const s = new Sprite({ x, y, dx, dy, r, e, face:1, dir:1 });
    s.phase = 'up';
    s.timer = between(cfg.moleStayMin, cfg.moleStayMax) / 1000;

    /* move sprite inside its hole for overflow-cropping */
    s.el.remove();
    hole.appendChild(s.el);

    sprites.push(s);
    return;
  }
  else {
    e = EMOJIS[Math.floor(rand(EMOJIS.length))];
    x = between(r, winW - r);
    y = between(r, winH - r);
    const ang = rand(Math.PI * 2);
    const v = between(cfg.vMin, cfg.vMax);
    dx = Math.cos(ang) * v;
    dy = Math.sin(ang) * v;
  }

  sprites.push(new Sprite({ x, y, dx, dy, r, e, face, dir }));
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

      if (cfg.mode === MODES.EMOJI || cfg.mode === MODES.BALLOONS) {
        burst(s.x, s.y); // normal emoji burst
      } else if (cfg.mode === MODES.FISH) {
        burst(s.x, s.y, BUBBLE); // fish bubble burst
      }
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
  resolveCollisions();
  maintain();
  sprites.forEach(s => s.draw());
  parts.forEach(p => p.draw());

  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);


// MODE TOGGLE
function setMode(m) {
  cfg.mode = m;
  // clear existing sprites
  sprites.forEach(s => s.el.remove());
  sprites.length = 0;
  pending = 0;

  /* remove old mole board */
  document.querySelectorAll('.moleHole').forEach(h => h.remove());
  gameContainer.style.display = 'block';

  if (m === MODES.MOLE) {
    cfg.count = cfg.moleCount;
    buildMoleBoard();
  }
  for (let i = 0; i < cfg.count; i++) scheduleSpawn();
}
