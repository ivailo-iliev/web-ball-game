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
  loop(_dt) {
    /* game logic here */
  }

  /* ---- 3.4 factory : create + register a sprite ---- */
  addSprite(desc) {
    /* merge defaults & desc, create new Sprite, push into array */
  }

  /* ---- 3.5 SPAWN pipeline ---- */
  _maybeSpawn(dt) {
    /* accumulate dt; when >= cfg.spawnEvery → call spawn()
       (game overrides spawn() to return {x,y,…})        */
  }

  /* ---- 3.6 COLLISION helpers ---- */
  _wallBounce(s) { /* flip vx / vy at edges (opt-in via cfg) */ }
  static _moveDefault(s, dt) { /* random drift */ }

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
