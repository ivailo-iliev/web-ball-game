/* ──────────────────────────────────────────────────────────────
   GLOBAL MINI-GAME ENGINE
   ────────────────────────────────────────────────────────────── */
(function (win) {
  'use strict';

  const scoreEl = [$('#teamAScore'), $('#teamBScore')];

const baseCfg = {
  max: 6,
  rRange: [25, 90],
  vRange: [10, 180],
  burstN: 14,
  burst: ['✨', '💥', '💫'],
  winPoints     : Infinity,                  // first team to reach this wins
  spawnDelayRange : [0, 3],            // seconds [min,max]
  emojis     : ['😀','😎','🤖','👻'], // fallback artwork
  collisions : false,              // enable physics collisions
  bounceX    : false,
  bounceY    : false
};

const BURST_VECTORS = Array.from({ length: 32 }, (_, i) => {
  const ang = (i / 32) * Math.PI * 2;
  return { x: Math.cos(ang), y: Math.sin(ang) };
});

/* ══════════ 2.  Sprite  – one emoji on screen ══════════ */
class Sprite {
  constructor({ x, y, dx, dy, r, e, angle = 0, scaleX = 1, scaleY = 1 }) {        /* data: {x,y,vx,vy,r,html…} */
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
    this.el.classList.add('sprite','spawn');
    this.el.textContent = e;
    const size = this.r * 2;
    this.style = this.el.style; // cache style object
    this.style.setProperty('--size', `${size}px`);
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

/* ══════════ 3.  BaseGame  – orchestrates many sprites ══════════ */
class BaseGame {

  /* ---- 3.1 constructor : store cfg & init state ---- */
  constructor(cfg = {}) {
    this.cfg = Object.assign({}, baseCfg, cfg);
    this.sprites = [];
    this.score = [0, 0];
    this.running = true;
    this.deadline = 0;
    this._raf = null;
    this._spawnElapsed = 0;
    this._nextSpawn = u.between(...this.cfg.spawnDelayRange);
    this._spawnQueue = [];              // ← NEW  event-driven queue

    this.burstEl = document.createElement('div');
    this.burstEl.className = 'burst';
    for (let i = 0; i < this.cfg.burstN; i++) {
      this.burstEl.appendChild(document.createElement('p'));
    }

    this.pointsEl = document.createElement('p');
    this.pointsEl.className = 'points';
  }

  /* ---- 3.2 init : call ONCE after construction ---- */
  init() {
    /* per‑game only — global boot already handled listeners & helpers */
    Sprite.layer   = Game.layer;
    this.container = Game.layer;
    this.W         = Game.W;
    this.H         = Game.H;

    this.ripple = Game.ripple;
    this.container.appendChild(this.burstEl);

    this.container.className =
      'game' + (this.gameName ? ' ' + this.gameName : '');
  }

  /* ---- 3.3 main loop : called from rAF ---- */
  loop = (ts) => {
    if (!this.running) return;
    const dt = (ts - this._last) / 1000;
    this._last = ts;
    const len = this.sprites.length;

    if (len < this.cfg.max) {
      this._spawnElapsed += dt;
      if (this._spawnElapsed >= this._nextSpawn) {
        this._spawnElapsed = 0;
        this._nextSpawn = u.between(...this.cfg.spawnDelayRange);
        const desc = this.spawn();
        if (desc) this.addSprite(desc);
      }
    }
    /* 2.  event-driven spawns — drain the queue */
    if (this._spawnQueue.length){
      for (const desc of this._spawnQueue) this.addSprite(desc);
      this._spawnQueue.length = 0;
    }
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
        this.miss(s);
      }

      if (s.ttl !== undefined && (s.ttl -= dt) <= 0) {
        this.miss(s);
      }

      if (s.alive) s.draw();
      if (!s.alive) this.sprites.splice(i, 1);
    }

    if (this.cfg.collisions) this._resolveCollisions();

    if (this.deadline && ts >= this.deadline) {
      const winner = this.score[0] > this.score[1] ? 0 : 1;
      return this.end(winner);
    }

    if (this.running) this._raf = requestAnimationFrame(this.loop);
  }

  /* ---- 3.4 factory : create + register a sprite ---- */
  // desc.s → object of style properties (camelCase or kebab)
  // desc.p → object of CSS custom properties (keys starting with --)
  addSprite(desc) {
    const [rMin, rMax] = this.cfg.rRange;
    const [vMin, vMax] = this.cfg.vRange;
    desc.r ??= u.between(rMin, rMax);
    const speed = u.between(vMin, vMax);
    const ang = u.rand(Math.PI * 2);
    desc.e ??= u.pick(this.cfg.emojis || []);
    desc.dx ??= Math.cos(ang) * speed;
    desc.dy ??= Math.sin(ang) * speed;

    const sprite = new Sprite(desc);
    if (desc.s) Object.assign(sprite.style, desc.s);
    if (desc.p) {
      for (const [k, v] of Object.entries(desc.p)) sprite.style.setProperty(k, v);
    }

    /* preserve all descriptor properties */
    Object.assign(sprite, desc);

    return sprite;
  }

  spawn() {
    return { x: u.rand(this.W), y: u.rand(this.H) };
  }

  /* ------------------------------------------------------------
   *  Public helper: enqueue a descriptor to appear next frame  */
  queueSpawn(desc){
    this._spawnQueue.push(desc);
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
  hit(s, team) {
    let pts;
    if (team === 0 || team === 1) {
      pts = this.calculatePoints(s);
      this.score[team] += pts;
      scoreEl[team].textContent = `${this.score[team]}`;
      this.emitPoints(s.x, s.y, pts, team);
    }
    this.emitBurst(s.x, s.y);
    if (typeof this.onHit === 'function') {
      const handled = this.onHit(s, team);
      if (handled === true) return;
    }
    this._popSprite(s);
    if ((team === 0 || team === 1) && this.score[team] >= this.cfg.winPoints) {
      this.end(team);
    }
  }

  /* ---- 3.7b MISS entry point ---- */
  miss(s) {
    if (typeof this.onMiss === 'function') this.onMiss(s);
    this._popSprite(s);
  }

  /* ---- 3.8 POP animation ---- */
  _popSprite(s) {                // visual + remove()
    s.alive = false;
    s.el.classList.remove('spawn');
    s.style.setProperty('--x', `${s.x - s.r}px`);
    s.style.setProperty('--y', `${s.y - s.r}px`);
    s.el.classList.add('pop');
  }

  emitBurst(x, y, emojiArr = this.cfg.burst) {
    this.burstEl.style.transform = `translate3d(${x}px, ${y}px, 0)`;
    const children = this.burstEl.children;
    for (let i = 0; i < children.length; i++) {
      const p = children[i];
      p.textContent = u.pick(emojiArr);
      const sp = 150 + u.rand(150);
      const vec = u.pick(BURST_VECTORS);
      const dx = vec.x * sp;
      const dy = vec.y * sp;
      p.style.setProperty('--dx', `${dx}px`);
      p.style.setProperty('--dy', `${dy}px`);
    }
    this.burstEl.classList.remove('animate');
    void this.burstEl.offsetWidth;
    this.burstEl.classList.add('animate');
  }

  emitPoints(x, y, points, team) {
    const el = this.pointsEl.cloneNode(true);
    el.textContent = `+${points}`;
    el.style.setProperty('--x', `${x}px`);
    el.style.setProperty('--y', `${y}px`);
    if (team === 0 || team === 1) {
      el.classList.add(Game.teams[team]);
    }
    this.container.appendChild(el);
    el.addEventListener('animationend', () => el.remove(), { once: true });
  }

  _showRipple(x, y) {
    Object.assign(this.ripple.style, { left: `${x}px`, top: `${y}px` });
    this.ripple.classList.remove('animate');
    void this.ripple.offsetWidth;
    this.ripple.classList.add('animate');
  }

  /* ---- handle hits triggered by pointer events or via Game.doHit ---- */
  doHit = (x, y, team) => {
    this._showRipple(x, y);
    for (const s of this.sprites) {
      if ((x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2) {
        this.hit(s, team);
        break;
      }
    }
  };

  /* ---- animation‑end dispatcher (called from the global listener) ---- */
  _onAnimEnd = (e) => {
    const el = e.target;
    const sp = el._sprite;
    if (!sp) return;
    if (el.classList.contains('spawn')) {
      el.classList.remove('spawn');
      if (this.running && sp.alive !== false) {
        this.sprites.push(sp);
        sp.draw();
        /* public hook — lets a game know the sprite is ready */
        if (typeof this.onSpriteAlive === 'function') {
          this.onSpriteAlive(sp);
        }
      }
    } else if (el.classList.contains('pop')) {
      sp.remove();
    }
  };

  /* ---- 3.9 END game ---- */
  end(winner) {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this._raf);
    this.sprites.forEach(sp => sp.remove());

    window.dispatchEvent(new CustomEvent('gameover', { detail: {
      winner,
      score: [...this.score]
    }}));
  }
}

/* ══════════ 4. helper : turn plain config into subclass ══════════ */
BaseGame.make = cfg => {
  class Game extends BaseGame {
    constructor() { super(cfg); Object.assign(this, cfg); }
  }
  Game.icon = cfg.icon;
  return Game;
};

/* ══════════ 5. registry + public runner ══════════ */

/* ---- one-time engine boot ---- */
function boot() {
  if (Game._booted) return;
  Game._booted = true;

  const layer = $('#game');
  if (!layer) throw new Error('Game.run: missing #game element');
  Game.layer = layer;

  const updateViewport = () => {
    ({ width: Game.W, height: Game.H } = window.visualViewport);
    if (inst) ({ width: inst.W, height: inst.H } = Game);
  };
  updateViewport();
  window.visualViewport.addEventListener('resize', updateViewport, { passive: true });

  /* pointer-down events are now handled globally in screen.js */
  layer.addEventListener('contextmenu',  e => e.preventDefault());
  window.addEventListener('contextmenu', e => e.preventDefault());
  layer.addEventListener('animationend', e => inst?._onAnimEnd?.(e));
}

/* internal engine state */
const Game = {
  _booted : false,
  layer   : null,
  W: 0, H: 0,
  ripple  : null,
  teams   : ['red', 'blue'],
};
const REG = [];
let idx = -1;
let inst = null;

function cleanupLayer() {
  const layer = Game.layer;
  if (!layer) return;
  // Using replaceChildren clears all nodes in a single operation
  // which is faster than repeatedly removing firstChild
  layer.replaceChildren();
  layer.className = '';
  layer.removeAttribute('style');
  Game.ripple = null;
}

Game.register = (id, cls) => {
  cls.prototype.gameName = id;
  REG.push({ id, cls });
  const launcher = $('#launcher');
  if (launcher && cls.icon) {
    const btn = Object.assign(document.createElement('button'), {
      type: 'button',
      textContent: cls.icon
    });
    Object.assign(btn.dataset, { game: id });
    launcher.prepend(btn);
  }
};

Object.defineProperty(Game, 'current', { get: () => idx });
Object.defineProperty(Game, 'list',    { get: () => REG.map(e => e.id) });

Game.setTeams = (a, b) => {
  Game.teams[0] = a;
  Game.teams[1] = b;
  scoreEl[0].className = a;
  scoreEl[1].className = b;
};

Game.doHit = (x, y, team) => {
  if (!inst) return;
  const idx = typeof team === 'number' ? team : Game.teams.indexOf(team);
  inst.doHit(x, y, idx);
};

/* ultra-light hit router (no DOM look-ups except on launcher page) */
Game.routeHit = (x, y, team) => {
  switch (window.currentPage) {
    case 1:                              /* game page */
      if (inst) Game.doHit(x, y, team);
      break;

    case 0: {                            /* launcher page */
      const btn = document.elementFromPoint(x, y)
                 ?.closest('#launcher button[data-game]');
      if (btn?.dataset.game) {
        Game.run(btn.dataset.game);
        if (typeof snapTo === 'function') snapTo(1);  /* scroll to game */
      }
      break;
    }

    /* page-2 (config) → ignore hit */
  }
};

Game.run = (target, opts = {}) => {
  boot(); /* make sure global engine bits exist */

  const i =
    typeof target === 'number'
      ? (target % REG.length + REG.length) % REG.length
      : REG.findIndex(e => e.id === target);
  if (i < 0) return;
  const cssHref = `styles/${REG[i].id}.css`;
  if (!$(`link[data-game='${REG[i].id}']`)) {
    const link = Object.assign(document.createElement('link'), {
      rel: 'stylesheet',
      href: cssHref
    });
    Object.assign(link.dataset, { game: REG[i].id });
    document.head.appendChild(link);
  }
  if (inst) inst.end();
  cleanupLayer();
  Game.ripple = document.createElement('div');
  Game.ripple.className = 'ripple';
  Game.layer.append(Game.ripple);
  idx = i;
  inst = new REG[i].cls();

  // allow per-run configuration overrides
  if (opts && typeof opts === 'object') {
    Object.assign(inst.cfg, opts);
  }

  const now = performance.now();
  inst.deadline =
    typeof inst.cfg.gameMinutes === 'number' && inst.cfg.gameMinutes > 0
      ? now + inst.cfg.gameMinutes * 60000
      : 0;

  scoreEl[0].textContent = '0';
  scoreEl[1].textContent = '0';

  inst.init(); /* per-game init only */
  if (typeof inst.onStart === 'function') inst.onStart();
  inst._last = now;
  inst.running = true;
  inst._raf = requestAnimationFrame(inst.loop);
};

//Object.freeze(Game);

/* ══════════ 6. export globals ══════════ */
win.Game   = Game;
win.BaseGame = BaseGame;
win.Sprite   = Sprite;

})(window);
