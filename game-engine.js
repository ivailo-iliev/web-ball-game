/* ──────────────────────────────────────────────────────────────
   GLOBAL MINI-GAME ENGINE
   ────────────────────────────────────────────────────────────── */
(function (win) {
  'use strict';

/* ══════════ 1.  Pure helpers – kept tiny & global ══════════ */
const R = {
  rand    : n       => /* … */,
  pick    : arr     => /* … */,
  between : (a, b)  => /* … */
};
win.R = R;

/* ══════════ 2.  Sprite  – one emoji on screen ══════════ */
class Sprite {
  constructor(data) {                 /* << paste DOM-build code */
    /* data: {x,y,vx,vy,r,html,hp,…} */
  }
  draw()   { /* position element */ }
  remove() { /* detach element, mark dead */ }
}
Sprite.layer = null;                  // set once in Game.init()

/* ══════════ 3.  BaseGame  – orchestrates many sprites ══════════ */
class BaseGame {

  /* ---- 3.1 constructor : store cfg & init state ---- */
  constructor(cfg = {}) {
    /* this.cfg = {defaults …cfg}                      */
    /* this.sprites = []; this.score = [0,0]; etc.     */
  }

  /* ---- 3.2 init : call ONCE after construction ---- */
  init(layer) {
    Sprite.layer = layer;                 // drawing parent
    /* set this.W / this.H, resize listener            */
    /* pointer listener → this.hit()                   */
    /* apply theme class if cfg.theme exists           */
  }

  /* ---- 3.3 main loop : called from rAF ---- */
  loop(dt) {
    this._maybeSpawn(dt);                 // internal timer
    this.sprites.forEach(s => {
      this.move ? this.move(s, dt)        // game override
                : BaseGame._moveDefault(s, dt);
      this._wallBounce(s);
      s.draw();
    });
    if (this.tick) this.tick(dt);         // optional per-frame hook
    this.sprites = this.sprites.filter(s => s.alive);
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

})(window);
