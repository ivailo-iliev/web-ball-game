/* ──────────────────────────────────────────────────────────────
   GLOBAL MINI-GAME ENGINE
   ────────────────────────────────────────────────────────────── */
(function (win) {
  'use strict';

  const scoreAEl = document.getElementById('teamAScore');
  const scoreBEl = document.getElementById('teamBScore');

/* ══════════ 1.  Pure helpers – kept tiny & global ══════════ */
const R = {
  rand    : n       => Math.random() * n,
  pick    : arr     => arr[Math.floor(R.rand(arr.length))],
  between : (a, b)  => a + R.rand(b - a)
};
win.R = R;


const DEFAULT_BURST = ['✨', '💥', '💫'];

const baseCfg = {
  max: 6,
  rRange: [25, 90],
  vRange: [10, 180],
  burstN: 14,
  burst: DEFAULT_BURST,
  winPoints     : 30,                  // first team to reach this wins
  spawnDelayRange : [0, 3],            // seconds [min,max]
  emojis     : ['😀','😎','🤖','👻'], // fallback artwork
  collisions : false,              // enable physics collisions
  bounceX    : false,
  bounceY    : false
};

/* ══════════ 2.  Sprite  – one emoji on screen ══════════ */
class Sprite {
  constructor({ x, y, dx, dy, r, e, angle = 0, scaleX = 1, scaleY = 1 }) {        /* data: {x,y,vx,vy,r,html,hp,…} */
    this.x = x; this.y = y;
    this.dx = dx; this.dy = dy;
    this.r = r; this.e = e;
    this.angle = angle;
    this.scaleX = scaleX;
    this.scaleY = scaleY;
    this.mass = r * r;
    this.alive = true;
    this.entered = false;

    this.el = document.createElement('div');
    this.el.className = 'emoji';
    this.el.classList.add('spawn');
    this.el.textContent = e;
    const size = this.r * 2;
    this.style = this.el.style; // cache style object
    Object.assign(this.style, {
      width: `${size}px`,
      height: `${size}px`,
      lineHeight: `${size}px`,
      fontSize: `${size}px`,
      transform: 'translate3d(var(--x), var(--y), 0) scale(1)'
    });

    this.style.setProperty('--x', `${this.x - this.r}px`);
    this.style.setProperty('--y', `${this.y - this.r}px`);

    if (Sprite.layer) Sprite.layer.appendChild(this.el);
    this.el._sprite = this;

  }

  draw() {
    this.style.transform =
      `translate3d(${this.x - this.r}px, ${this.y - this.r}px, 0) rotate(${this.angle}rad) scale(${this.scaleX}, ${this.scaleY})`;
  }

  remove() {
    this.alive = false;
    this.el.remove();
  }
}
Sprite.layer = null;                  // set once in Game.init()
Sprite.SPAWN_TIME = 300;             // ms - must match CSS animation duration
Sprite.POP_TIME   = 200;             // ms - pop animation duration

/* ══════════ 3.  BaseGame  – orchestrates many sprites ══════════ */
class BaseGame {

  /* ---- 3.1 constructor : store cfg & init state ---- */
  constructor(cfg = {}) {
    this.cfg = Object.assign({}, baseCfg, cfg);
    this.sprites = [];
    this.score = [0, 0];
    this.running = true;
    this._raf = null;
    this._loop = this.loop.bind(this);
    this._spawnElapsed = 0;
    this._nextSpawn = R.between(...this.cfg.spawnDelayRange);
  }

  /* ---- 3.2 init : call ONCE after construction ---- */
  init(layer) {
    Sprite.layer = layer;                 // drawing parent
    this.container = layer;
    this.winW = window.visualViewport.width || window.innerWidth;
    this.winH = window.visualViewport.height || window.innerHeight;
    this.W = this.winW;
    this.H = this.winH;
    this._resize = () => {
      this.winW = window.visualViewport.width || window.innerWidth;
      this.winH = window.visualViewport.height || window.innerHeight;
      this.W = this.winW;
      this.H = this.winH;
    };
    window.addEventListener('resize', this._resize);
    window.addEventListener('orientationchange', this._resize);

    this.burstTemplate = document.createElement('div');
    this.burstTemplate.className = 'burst';
    this.burstTemplate.style.display = 'none';
    this.container.appendChild(this.burstTemplate);

    this.ripple = document.createElement('div');
    this.ripple.classList.add('ripple');
    this.container.appendChild(this.ripple);

    this._onAnimEnd = e => {
      const el = e.target;
      const sp = el._sprite;
      if (!sp) return;
      if (el.classList.contains('spawn')) {
        el.classList.remove('spawn');
        if (this.running && sp.alive !== false) {
          this.sprites.push(sp);
          sp.draw();
        }
      } else if (el.classList.contains('pop')) {
        sp.remove();
      }
    };
    this.container.addEventListener('animationend', this._onAnimEnd);

    this.onPointerDown = e => {
      const rect = this.container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;

      this._showRipple(x, y);

      for (const s of this.sprites) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2) {
          this.hit(s, e.button === 2 ? 1 : 0);
          break;
        }
      }
    };
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this._contextHandler = e => e.preventDefault();
    this.container.addEventListener('contextmenu', this._contextHandler);
    this.container.className = 'game' + (this.gameName ? ' ' + this.gameName : '');
  }

  /* ---- 3.2.1 spawn initial sprite(s) ---- */
  // Removed start() method; spawning handled in Game.run

  /* ---- 3.3 main loop : called from rAF ---- */
  loop(ts) {
    if (!this.running) return;
    const dt = (ts - this._last) / 1000;
    this._last = ts;
    if (this.sprites.length < this.cfg.max) {
      this._spawnElapsed += dt;
      if (this._spawnElapsed >= this._nextSpawn) {
        this._spawnElapsed = 0;
        this._nextSpawn = R.between(...this.cfg.spawnDelayRange);
        const desc = this.spawn();
        if (desc) this.addSprite(desc);
      }
    }
    const len = this.sprites.length;
    for (let i = len - 1; i >= 0; i--) {
      const s = this.sprites[i];
      this.move ? this.move(s, dt) : BaseGame._moveDefault(s, dt);
      this._wallBounce(s);

      const left   = s.x - s.r;
      const right  = s.x + s.r;
      const top    = s.y - s.r;
      const bottom = s.y + s.r;
      if (!s.entered) {
        if (right >= 0 && left <= this.W && bottom >= 0 && top <= this.H) {
          s.entered = true;
        }
      } else if (
        right < -s.r ||
        left  > this.W + s.r ||
        bottom < -s.r ||
        top > this.H + s.r
      ) {
        s.remove();
      }

      if (s.ttl !== undefined && (s.ttl -= dt) <= 0) {
        this._popSprite(s);
      }

      if (s.alive) s.draw();
      if (!s.alive) this.sprites.splice(i, 1);
    }

    if (this.cfg.collisions) this._resolveCollisions();
    if (this.running) this._raf = requestAnimationFrame(this._loop);
  }

  /* ---- 3.4 factory : create + register a sprite ---- */
  // desc.s → object of style properties (camelCase or kebab)
  // desc.p → object of CSS custom properties (keys starting with --)
  addSprite(desc) {
    const [rMin, rMax] = this.cfg.rRange;
    const [vMin, vMax] = this.cfg.vRange;
    desc.r ??= R.between(rMin, rMax);
    const speed = R.between(vMin, vMax);
    const ang = R.rand(Math.PI * 2);
    desc.e ??= R.pick(this.cfg.emojis || []);
    desc.dx = Math.cos(ang) * speed;
    desc.dy = Math.sin(ang) * speed;

    const sprite = new Sprite(desc);
    sprite.hp = 1;
    if (desc.s) Object.assign(sprite.style, desc.s);
    if (desc.p) {
      for (const [k, v] of Object.entries(desc.p)) sprite.style.setProperty(k, v);
    }
    if (desc.ttl !== undefined) sprite.ttl = desc.ttl;

    // movement begins when spawn animation ends via animationend handler

    return sprite;
  }

  spawn() {
    return { x: R.rand(this.W), y: R.rand(this.H) };
  }

  /* ---- 3.6 COLLISION helpers ---- */
  _wallBounce(s) {
    const W = this.W, H = this.H;
    if (this.cfg.bounceX && ((s.x - s.r < 0 && s.dx < 0) || (s.x + s.r > W && s.dx > 0))) {
      s.dx *= -1;
    }
    if (this.cfg.bounceY && ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0))) {
      s.dy *= -1;
    }
  }
  static _moveDefault(s, dt) {
    s.x += s.dx * dt;
    s.y += s.dy * dt;
  }

  _resolveCollisions() {
    const len = this.sprites.length;
    for (let i = 0; i < len; i++) {
      const a = this.sprites[i];
      if (!a.alive) continue;
      for (let j = i + 1; j < len; j++) {
        const b = this.sprites[j];
        if (!b.alive) continue;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const dist2 = dx * dx + dy * dy;
        const min = a.r + b.r;
        const min2 = min * min;
        if (dist2 === 0 || dist2 >= min2) continue;
        const dist = Math.sqrt(dist2);
        const nx = dx / dist;
        const ny = dy / dist;
        const overlap = min - dist;
        const tot = a.mass + b.mass;
        a.x -= nx * overlap * (b.mass / tot);
        a.y -= ny * overlap * (b.mass / tot);
        b.x += nx * overlap * (a.mass / tot);
        b.y += ny * overlap * (a.mass / tot);
        const rvx = b.dx - a.dx;
        const rvy = b.dy - a.dy;
        const rel = rvx * nx + rvy * ny;
        if (rel > 0) continue;
        const impulse = -(1 + 1) * rel / (1 / a.mass + 1 / b.mass);
        const ix = impulse * nx;
        const iy = impulse * ny;
        a.dx -= ix / a.mass;
        a.dy -= iy / a.mass;
        b.dx += ix / b.mass;
        b.dy += iy / b.mass;
      }
    }
  }

  calculatePoints(s) {
    const [ , rMax] = this.cfg.rRange;
    const [ , vMax] = this.cfg.vRange;
    const speed = Math.hypot(s.dx, s.dy);
    const sizeRatio = rMax / s.r;
    const speedRatio = speed / vMax;
    return Math.max(10, Math.round(sizeRatio * speedRatio * 400));
  }

  /* ---- 3.7 HIT entry point ---- */
  hit(s, team = 0) {
    if (this.onHit && this.onHit(s, team) === false) return;  // optional veto
    if (--s.hp > 0) return;
    this.score[team] += this.calculatePoints(s);
    scoreAEl.textContent = `${this.score[0]}`;
    scoreBEl.textContent = `${this.score[1]}`;
    this._popSprite(s);
    if (this.score[team] >= this.cfg.winPoints) this.end(team);
  }

  /* ---- 3.8 POP animation ---- */
  _popSprite(s) {                // visual + remove()
    s.alive = false;
    s.el.classList.remove('spawn');
    s.style.setProperty('--x', `${s.x - s.r}px`);
    s.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.classList.add('pop');
    this.burst(s.x, s.y);
  }

  burst(x, y, emojiArr = this.cfg.burst) {
    for (let i = 0; i < this.cfg.burstN; i++) {
      const sp = 150 + R.rand(150);
      const ang = R.rand(Math.PI * 2);
      const dxp = Math.cos(ang) * sp;
      const dyp = Math.sin(ang) * sp;
      const b = this.burstTemplate.cloneNode(true);
      b.style.display = 'block';
      b.textContent = emojiArr[Math.floor(R.rand(emojiArr.length))];
      Object.assign(b.style, { left: `${x}px`, top: `${y}px` });
      b.style.setProperty('--dx', `${dxp}px`);
      b.style.setProperty('--dy', `${dyp}px`);
      this.container.appendChild(b);
      b.addEventListener('animationend', () => b.remove(), { once: true });
    }
  }

  _showRipple(x, y) {
    Object.assign(this.ripple.style, { left: `${x}px`, top: `${y}px` });
    this.ripple.classList.remove('animate');
    void this.ripple.offsetWidth;
    this.ripple.classList.add('animate');
  }

  /* ---- 3.9 END game ---- */
  end(winner) {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.sprites.forEach(sp => sp.remove());
    this.container.removeEventListener('pointerdown', this.onPointerDown);
    this.container.removeEventListener('contextmenu', this._contextHandler);
    this.container.removeEventListener('animationend', this._onAnimEnd);
    window.removeEventListener('resize', this._resize);
    window.removeEventListener('orientationchange', this._resize);
    if (this.ripple) this.ripple.remove();
    this.container.querySelectorAll('.burst').forEach(b => b.remove());
    window.dispatchEvent(new CustomEvent('gameover', { detail: {
      winner,
      score: [...this.score]
    }}));
  }
}

/* ══════════ 4. helper : turn plain config into subclass ══════════ */
BaseGame.make = cfg => class Game extends BaseGame {
  constructor() { super(cfg); Object.assign(this, cfg); }
};

/* ══════════ 5. registry + public runner ══════════ */
const Game = {};
const REG = [];
let idx = -1;
let inst = null;

Game.register = (id, cls) => {
  cls.prototype.gameName = id;
  REG.push({ id, cls });
};

Object.defineProperty(Game, 'current', { get: () => idx });
Object.defineProperty(Game, 'list',    { get: () => REG.map(e => e.id) });

Game.setTeams = (a, b) => {
  scoreAEl.className = a;
  scoreBEl.className = b;
};

Game.run = target => {
  const i = typeof target === 'number'
           ? (target % REG.length + REG.length) % REG.length
           : REG.findIndex(e => e.id === target);
  if (i < 0) return;
  if (inst) inst.end();
  idx = i;
  inst = new REG[i].cls();
  scoreAEl.textContent = '0';
  scoreBEl.textContent = '0';
  const layer = document.getElementById('gameLayer');
  if (!layer) {
    const msg = 'Game.run: missing element with id "gameLayer"';
    console.error(msg);
    throw new Error(msg);
  }
  inst.init(layer);
  if (typeof inst.onStart === 'function') inst.onStart();
  const desc = inst.spawn();
  if (desc) inst.addSprite(desc);
  inst._last = performance.now();
  inst.running = true;
  inst._raf = requestAnimationFrame(inst._loop);
};

// Restart the current game when the window is resized
let resizeTimer = null;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    if (inst) {
      inst.end();
      Game.run(idx);
    }
  }, 200);
}, { passive: true });

Object.freeze(Game);

/* ══════════ 6. export globals ══════════ */
win.Game   = Game;
win.BaseGame = BaseGame;
win.Sprite   = Sprite;

})(window);
