/* ──────────────────────────────────────────────────────────────
   GLOBAL MINI-GAME ENGINE
   ────────────────────────────────────────────────────────────── */
(function (win) {
  'use strict';

/* ══════════ 1.  Pure helpers – kept tiny & global ══════════ */
const R = {
  rand    : n       => Math.random() * n,
  pick    : arr     => arr[Math.floor(R.rand(arr.length))],
  between : (a, b)  => a + R.rand(b - a)
};
win.R = R;

function applyTransform(el, x, y, rot, sx, sy) {
  const st = el._st || (el._st = el.style);
  st.transform =
    `translate3d(${x}px, ${y}px, 0) rotate(${rot}rad) scale(${sx}, ${sy})`;
}

/* -------- GAME MODES -------- */
const MODES = {
  FISH: 'fish',
  EMOJI: 'emoji',
  BALLOONS: 'balloons',
  MOLE: 'mole'
};

const baseCfg = {
  mode: MODES.EMOJI,
  count: 6,
  rMin: 25,
  rMax: 90,
  vMin: 10,
  vMax: 180,
  spin: 25,
  burstN: 14,
  particleLife: 1,
  burst: ['✨', '💥', '💫']
};

/* ══════════ 2.  Sprite  – one emoji on screen ══════════ */
class Sprite {
  constructor({ x, y, dx, dy, r, e, face, dir }) {        /* data: {x,y,vx,vy,r,html,hp,…} */
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
    const size = this.r * 2;
    Object.assign(this.el.style, {
      width: `${size}px`,
      height: `${size}px`,
      lineHeight: `${size}px`,
      fontSize: `${size}px`
    });

    if (Sprite.layer) Sprite.layer.appendChild(this.el);
    this.el._sprite = this;
    this.draw();
  }

  draw() {
    this.el.style.transform =
      `translate3d(${this.x - this.r}px, ${this.y - this.r}px, 0)`;
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
    this.timers = [];
    this.running = true;
    this.spawnClock = 0;
  }

  /* ---- 3.2 init : call ONCE after construction ---- */
  init(layer) {
    Sprite.layer = layer;                 // drawing parent
    this.container = layer;
    this.W = window.innerWidth;
    this.H = window.innerHeight;
    const resize = () => {
      this.W = window.innerWidth;
      this.H = window.innerHeight;
    };
    window.addEventListener('resize', resize);
    window.addEventListener('orientationchange', resize);

    this.onPointerDown = e => {
      const rect = this.container.getBoundingClientRect();
      const x = e.clientX - rect.left;
      const y = e.clientY - rect.top;
      for (const s of this.sprites) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2) {
          this.hit(s, e.button === 2 ? 1 : 0);
          break;
        }
      }
    };
    this.container.addEventListener('pointerdown', this.onPointerDown);
    this.container.addEventListener('contextmenu', e => e.preventDefault());
    this.container.className = 'game' + (this.cfg.theme ? ` ${this.cfg.theme}` : '');
  }

  /* ---- 3.3 main loop : called from rAF ---- */
  loop(dt) {
    if (this.sprites.length < this.cfg.count) {
      this.spawnClock -= dt;
      if (this.spawnClock <= 0) {
        this.spawnClock = R.rand(3);
        const desc = this.spawn();
        if (desc) this.addSprite(desc);
      }
    }
    for (const s of this.sprites) {
      this.move ? this.move(s, dt) : BaseGame._moveDefault(s, dt);
      this._wallBounce(s);
      s.draw();
    }
    this.sprites = this.sprites.filter(sp => sp.alive);
    if (this.tick) this.tick(dt);
  }

  /* ---- 3.4 factory : create + register a sprite ---- */
  addSprite(desc) {
    const r = desc.r ?? R.between(this.cfg.rMin, this.cfg.rMax);
    const speed = R.between(this.cfg.vMin, this.cfg.vMax);
    const ang = R.rand(Math.PI * 2);
    const defaults = {
      r,
      e: desc.e ?? R.pick(this.cfg.emojis || []),
      dx: Math.cos(ang) * speed,
      dy: Math.sin(ang) * speed
    };
    const sprite = new Sprite(Object.assign(defaults, desc));
    this.sprites.push(sprite);
    return sprite;
  }

  spawn() {
    return { x: R.rand(this.W), y: R.rand(this.H) };
  }

  /* ---- 3.5 SPAWN pipeline ---- */
  _maybeSpawn(dt) {
    /* accumulate dt; when >= cfg.spawnEvery → call spawn()
       (game overrides spawn() to return {x,y,…})        */
  }

  /* ---- 3.6 COLLISION helpers ---- */
  _wallBounce(s) {
    const W = this.W, H = this.H;
    if ((s.x - s.r < 0 && s.dx < 0) || (s.x + s.r > W && s.dx > 0)) s.dx *= -1;
    if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
  }
  static _moveDefault(s, dt) {
    s.x += s.dx * dt;
    s.y += s.dy * dt;
    let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
    const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
    applyTransform(s.el, s.x - s.r, s.y - s.r, rot, scale, scale);
  }

  /* ---- 3.7 HIT entry point ---- */
  hit(s, team = 0) {
    if (this.onHit && this.onHit(s, team) === false) return;  // optional veto
    /* decrement hp; if hp <= 0 → this._popSprite(s, team);   */
    /* update score; dispatch 'score' event; check winPoints  */
  }

  /* ---- 3.8 POP animation ---- */
  _popSprite(s, team) {                // visual + remove()
    /* add .pop class, optional particles / sound            */
    /* setTimeout(s.remove, cfg.popTime);                    */
  }

  /* ---- 3.9 END game ---- */
  end(winner) {
    /* stop loop (this.running=false), kill remaining sprites */
    /* dispatch 'gameover' CustomEvent                        */
  }
}

/* ══════════ 4. helper : turn plain config into subclass ══════════ */
BaseGame.make = cfg => class Game extends BaseGame {
  constructor() { super(cfg); Object.assign(this, cfg); }
};

/* ══════════ 5. registry + public runner ══════════ */
const REG = [];
function GameRegister(id, cls) { REG.push({ id, cls }); }

function GameRun(id) {
  const entry = REG.find(e => e.id === id) || REG[0];
  const game  = new entry.cls();
  const layer = document.getElementById('gameLayer') || document.body;
  game.init(layer);

  let last = performance.now();
  (function frame(now) {
    if (!game.running) return;
    const dt = (now - last) / 1000; last = now;
    game.loop(dt);
    requestAnimationFrame(frame);
  })();
}

/* ══════════ 6. export globals ══════════ */
win.GameRegister = GameRegister;
win.GameRun      = GameRun;
win.BaseGame     = BaseGame;
win.Sprite       = Sprite;

})(window);
