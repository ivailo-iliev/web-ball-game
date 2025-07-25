(function() {
  'use strict';

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

  const DELAY = 3000;

  const rand = n => Math.random() * n;
  const between = (a, b) => a + rand(b - a);
  const randRadius = () => between(Game.cfg.rMin, Game.cfg.rMax);
  const randSpeed = () => between(Game.cfg.vMin, Game.cfg.vMax);
  const randX = r => between(r, Game.winW - r);
  const randY = r => between(r, Game.winH - r);
  const pick = arr => arr[Math.floor(rand(arr.length))];

  const randVec = (speed = randSpeed()) => {
    const ang = rand(Math.PI * 2);
    return { dx: Math.cos(ang) * speed, dy: Math.sin(ang) * speed };
  };

  function applyTransform(el, x, y, rot, sx, sy) {
    const st = el._st || (el._st = el.style);
    st.transform =
      `translate3d(${x}px, ${y}px, 0) rotate(${rot}rad) scale(${sx}, ${sy})`;
  }

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
      el.style.setProperty('--life', `${Game.cfg.particleLife}s`);
      el.addEventListener('animationend', () => el.remove(), { once: true });
      Game.elements.container.appendChild(el);
      this.el = el;
    }
  }

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
      this.mode = Game.engine ? Game.engine.currentMode : null;

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

      Game.elements.container.appendChild(this.el);
      this.el._sprite = this;
      this.draw();
    }

    reset() {
      const W = Game.winW, H = Game.winH;
      this.r = Game.utils.randRadius();
      const r = this.r;
      const size = r * 2;
      Object.assign(this.el.style, {
        width: `${size}px`,
        height: `${size}px`,
        lineHeight: `${size}px`,
        fontSize: `${size}px`
      });
      this.x = Game.utils.randX(r);
      this.y = Game.utils.randY(r);
      const { dx, dy } = Game.utils.randVec();
      this.dx = dx;
      this.dy = dy;
      this.pop = 0;
      this.alive = true;
    }

    update(dt) { if (this.mode && this.mode.update) this.mode.update(this, dt); }
    draw()   { if (this.mode && this.mode.draw)   this.mode.draw(this); }
    doHit()  { if (this.mode && this.mode.hit)    this.mode.hit(this); }
    contains(px, py) {
      if (this.mode && this.mode.contains) return this.mode.contains(this, px, py);
      return false;
    }
  }

  class GameMode {
    constructor(opts = {}) { this.opts = opts; }
    spawn() {}
    updateSpriteMovement(s, dt) { s.x += s.dx * dt; s.y += s.dy * dt; }
    checkOffscreen(s) {
      const W = Game.winW, H = Game.winH;
      if (
        s.x < -s.r * 2 ||
        s.x > W + s.r * 2 ||
        s.y < -s.r * 2 ||
        s.y > H + s.r * 2
      ) { s.alive = false; }
    }
    update(s, dt) { if (!s.alive) return; this.updateSpriteMovement(s, dt); this.checkOffscreen(s); }
    draw(_s) {}
    hit(s) { s.pop = 0.01; }
    contains(s, px, py) { return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2; }
    resolveCollisions() {}
    setup() {}
    cleanup() {}
    onRemove(_s) {}
  }

  class Engine {
    constructor(rootEl, config = {}) {
      this.root = rootEl;
      this.container = document.createElement('div');
      this.container.id = 'game';
      this.root.appendChild(this.container);

      this.as = document.getElementById('teamAScore');
      this.bs = document.getElementById('teamBScore');

      this.winW = window.visualViewport.width || window.innerWidth;
      this.winH = window.visualViewport.height || window.innerHeight;
      Game.winW = this.winW;
      Game.winH = this.winH;

      this.state = { sprites: [], pending: 0, scores: { teamA: 0, teamB: 0 } };
      this.modes = {};
      this.spawnTimers = [];
      this.currentMode = null;

      this.cfg = Object.assign({}, baseCfg, config);
      Game.cfg = this.cfg;

      this.onSpritePointerDown = this.onSpritePointerDown.bind(this);
      this.container.addEventListener('pointerdown', this.onSpritePointerDown);

      window.addEventListener('orientationchange', () => {
        this.winW = window.visualViewport.width || window.innerWidth;
        this.winH = window.visualViewport.height || window.innerHeight;
        Game.winW = this.winW;
        Game.winH = this.winH;
      });

      this.burstTemplate = document.createElement('div');
      this.burstTemplate.className = 'burst';
      this.burstTemplate.style.display = 'none';
      this.container.appendChild(this.burstTemplate);

      this.ripple = document.createElement('div');
      this.ripple.classList.add('ripple');
      this.container.appendChild(this.ripple);

      const cfgGame = App.Config.get();
      this.as.className = cfgGame.teamA;
      this.bs.className = cfgGame.teamB;
      this.updateScore();

      this.addInputListeners();

      for (let i = 0; i < this.cfg.count; i++) this.scheduleSpawn();

      this.last = performance.now();
      requestAnimationFrame(this.loop.bind(this));
    }

    registerMode(name, handler) {
      this.modes[name] = handler;
      handler.engine = this;
      if (typeof handler.init === 'function') handler.init();
      return handler;
    }

    buildCfg(mode) {
      return Object.assign({}, baseCfg, this.modes[mode]?.opts || {}, { mode });
    }

    scheduleSpawn() {
      this.state.pending++;
      const id = setTimeout(() => {
        this.spawn();
        this.state.pending--;
        const idx = this.spawnTimers.indexOf(id);
        if (idx !== -1) this.spawnTimers.splice(idx, 1);
      }, rand(DELAY));
      this.spawnTimers.push(id);
    }

    clearSpawnTimers() {
      for (const t of this.spawnTimers) clearTimeout(t);
      this.spawnTimers.length = 0;
    }

    spawn() { if (this.currentMode && this.currentMode.spawn) this.currentMode.spawn(); }

    burst(x, y, emojiArr = this.cfg.burst) {
      for (let i = 0; i < this.cfg.burstN; i++) {
        const sp = 150 + rand(150);
        const { dx: dxp, dy: dyp } = randVec(sp);
        const b = this.burstTemplate.cloneNode(true);
        b.style.display = 'block';
        b.textContent = emojiArr[Math.floor(rand(emojiArr.length))];
        Object.assign(b.style, { left: `${x}px`, top: `${y}px` });
        b.style.setProperty('--dx', `${dxp}px`);
        b.style.setProperty('--dy', `${dyp}px`);
        this.container.appendChild(b);
        b.addEventListener('animationend', () => b.remove(), { once: true });
      }
    }

    maintain() {
      for (let i = this.state.sprites.length - 1; i >= 0; i--) {
        if (!this.state.sprites[i].alive) {
          const sp = this.state.sprites[i];
          if (sp.mode && sp.mode.onRemove) sp.mode.onRemove(sp);
          sp.el.remove();
          this.state.sprites.splice(i, 1);
        }
      }
      while (this.state.sprites.length + this.state.pending < this.cfg.count) this.scheduleSpawn();
    }

    updateScore() {
      this.as.textContent = `${this.state.scores.teamA}`;
      this.bs.textContent = `${this.state.scores.teamB}`;
    }

    setTeams(a, b) { this.as.className = a; this.bs.className = b; }

    calculatePoints(sprite) {
      const speed = Math.hypot(sprite.dx, sprite.dy);
      const sizeRatio = this.cfg.rMax / sprite.r;
      const speedRatio = speed / this.cfg.vMax;
      return Math.max(10, Math.round(sizeRatio * speedRatio * 400));
    }

    doHit(px, py, team, sprite) {
      Object.assign(this.ripple.style, { left: `${px}px`, top: `${py}px` });
      this.ripple.classList.remove('animate');
      void this.ripple.offsetWidth;
      this.ripple.classList.add('animate');

      const targets = sprite ? [sprite] : this.state.sprites;
      for (const s of targets) {
        if (s.alive && (!sprite ? s.contains(px, py) : true) && s.pop === 0) {
          s.doHit();
          this.state.scores[team] += this.calculatePoints(s);
          this.updateScore();
          break;
        }
      }
    }

    preventContextMenu(e) { e.preventDefault(); }
    addInputListeners() { window.addEventListener('contextmenu', this.preventContextMenu); }
    removeInputListeners() { window.removeEventListener('contextmenu', this.preventContextMenu); }

    onSpritePointerDown(e) {
      const target = e.target.closest('.emoji');
      if (!target || !target._sprite) return;
      const rect = this.container.getBoundingClientRect();
      this.doHit(
        e.clientX - rect.left,
        e.clientY - rect.top,
        e.button === 2 ? 'teamA' : 'teamB',
        target._sprite
      );
    }

    loop(now) {
      const dt = (now - this.last) / 1000;
      this.last = now;

      this.state.sprites.forEach(s => s.update(dt));
      if (this.currentMode && this.currentMode.resolveCollisions) this.currentMode.resolveCollisions();
      this.maintain();
      this.state.sprites.forEach(s => s.draw());

      requestAnimationFrame(this.loop.bind(this));
    }

    setMode(m) {
      if (this.currentMode && this.currentMode.cleanup) this.currentMode.cleanup();
      this.removeInputListeners();
      this.cfg = this.buildCfg(m);
      Game.cfg = this.cfg;
      this.currentMode = this.modes[m];

      this.state.sprites.forEach(s => s.el.remove());
      this.state.sprites.length = 0;
      this.clearSpawnTimers();
      this.state.pending = 0;

      if (this.currentMode && this.currentMode.setup) this.currentMode.setup();

      this.addInputListeners();

      for (let i = 0; i < this.cfg.count; i++) this.scheduleSpawn();
    }
  }

  const Game = {
    MODES,
    Engine,
    GameMode,
    Sprite,
    utils: { rand, between, randRadius, randSpeed, randX, randY, randVec, pick, applyTransform }
  };

  const engine = new Game.Engine(document.getElementById('gameScreen'));
  Game.engine = engine;
  Game.cfg = engine.cfg;
  Game.state = engine.state;
  Game.elements = { container: engine.container };
  Game.winW = engine.winW;
  Game.winH = engine.winH;
  Game.setTeams = (...a) => engine.setTeams(...a);
  Game.setMode = (...a) => engine.setMode(...a);
  Game.spawn = (...a) => engine.spawn(...a);
  Game.burst = (...a) => engine.burst(...a);
  Game.registerMode = (...a) => engine.registerMode(...a);
  Game.buildCfg = (...a) => engine.buildCfg(...a);
  Game.doHit = (...a) => engine.doHit(...a);

  window.Game = Game;
})();

// ------------------ Emoji Mode ------------------
(function(Game){
  const cfg = {
    emojis: [
      '🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉','⭐','🥳','💎',
      '🍀','🌸','🍕','🍔','🍟','🍦','🍩','🍪','🍉','🍓','🍒','🍇','🧸','🎁','🎀','🪁',
      '🪀','🎨','🎧','🎮','🏀','⚾️','🏈','🎯','🚁','✈️','🦄','🐱','🐶','🐸','🐥','🐝','🦋',
      '🌈','🔥','💖','🍭','🍬','🧁','🎂','🍰','🥐','🍌','🍊','🥝','🛼','⛸️','🐰','🐼','🐨',
      '🐧','🐿️','🦊','🐢','🦖','🐯','🐮','🐷','🐹','🐭','💗','💝','😻','💞','🪅','🍿','🥤',
      '🧋','🌞','🌺','🌵','📸','⌚','🧸'
    ]
  };

  class EmojiGame extends Game.GameMode {
    spawn() {
      const r = Game.utils.randRadius();
      const e = Game.utils.pick(cfg.emojis);
      const x = Game.utils.randX(r);
      const y = Game.utils.randY(r);
      const { dx, dy } = Game.utils.randVec();
      Game.state.sprites.push(new Game.Sprite({ x, y, dx, dy, r, e, face:1, dir:1 }));
    }
    update(s, dt) {
      this.updateSpriteMovement(s, dt);
      if (s.pop > 0) {
        s.pop += dt;
        if (s.pop > 0.25) s.alive = false;
      } else {
        const W = Game.winW, H = Game.winH;
        if ((s.x - s.r < 0 && s.dx < 0) || (s.x + s.r > W && s.dx > 0)) s.dx *= -1;
        if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
      }
      this.checkOffscreen(s);
    }
    draw(s) {
      if (!s.alive) return;
      let scale = s.pop > 0 ? Math.max(0.01, 1 - s.pop * 4) : 1;
      const rot = Math.sin((s.x + s.y) * 0.03) * 0.10;
      Game.utils.applyTransform(s.el, s.x - s.r, s.y - s.r, rot, scale, scale);
    }
    hit(s) { s.pop = 0.01; Game.burst(s.x, s.y); }
    resolveCollisions() {
      for (let i = 0; i < Game.state.sprites.length; i++) {
        const a = Game.state.sprites[i];
        if (!a.alive) continue;
        for (let j = i + 1; j < Game.state.sprites.length; j++) {
          const b = Game.state.sprites[j];
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

  Game.registerMode(Game.MODES.EMOJI, new EmojiGame(cfg));
})(Game);


// ------------------ Fish Mode ------------------
(function(Game){
  const cfg = {
    fish: ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'],
    bubble: ['🫧']
  };

  class FishGame extends Game.GameMode {
    spawn() {
      const r = Game.utils.randRadius();
      const face = Math.random() < 0.5 ? 1 : -1;
      const x = face === 1 ? -r : Game.winW + r;
      const y = Game.utils.randY(r);
      const dx = face * Game.utils.randSpeed();
      const dy = Game.utils.between(-20, 20);
      const e = Game.utils.pick(cfg.fish);
      const dir = -face;
      Game.state.sprites.push(new Game.Sprite({ x, y, dx, dy, r, e, face, dir }));
    }
    update(s, dt) {
      this.updateSpriteMovement(s, dt);
      if (s.pop > 0) {
        s.pop += dt;
        s.angle += dt * Game.cfg.spin * s.dir;
        s.dx *= 1.25;
      } else {
        const H = Game.winH;
        if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > H && s.dy > 0)) s.dy *= -1;
      }
      this.checkOffscreen(s);
    }
    draw(s) {
      if (!s.alive) return;
      const rot = s.angle;
      const flip = s.face > 0 ? -1 : 1;
      Game.utils.applyTransform(s.el, s.x - s.r, s.y - s.r, rot, flip, 1);
    }
    hit(s) { s.pop = 0.01; Game.burst(s.x, s.y, cfg.bubble); }
  }

  Game.registerMode(Game.MODES.FISH, new FishGame(cfg));
})(Game);

// ------------------ Balloon Mode ------------------
(function(Game){
  const cfg = {
    brightMin: 0.9,
    brightMax: 2,
    satMin: 0.9,
    satMax: 1.0,
    bVMin: 25,
    bVMax: 60,
    balloons: ['🎈'],
    balloonRare: ['☁️','🪁','🦋','⚡','🪙','⭐','🍂']
  };

  class BalloonGame extends Game.GameMode {
    spawn() {
      const r = Game.utils.randRadius();
      const face = -1;
      const rare = Math.random() < 0.05;
      const e = rare ? Game.utils.pick(cfg.balloonRare) : cfg.balloons[0];
      const x = Game.utils.randX(r);
      const y = Game.winH + r;
      const dx = Game.utils.between(-20, 20);
      const dy = -Game.utils.between(cfg.bVMin, cfg.bVMax);
      const s = new Game.Sprite({ x, y, dx, dy, r, e, face, dir:1 });
      const hue = Math.random() * 360;
      const bri = Game.utils.between(cfg.brightMin, cfg.brightMax);
      const sat = Game.utils.between(cfg.satMin, cfg.satMax);
      s.el.style.filter = `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
      Game.state.sprites.push(s);
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
      Game.utils.applyTransform(s.el, s.x - s.r, s.y - s.r, rot, scale, scale);
    }
    hit(s) { s.pop = 0.01; Game.burst(s.x, s.y); }
  }

  Game.registerMode(Game.MODES.BALLOONS, new BalloonGame(cfg));
})(Game);

// ------------------ Mole Mode ------------------
(function(Game){
  const cfg = {
    moleUpV: 350,
    moleStayMin: 1000,
    moleStayMax: 3000,
    moleCount: 12,
    animals: ['🐭','🐰'],
    rows: [3, 2, 3]
  };

  class MoleGame extends Game.GameMode {
    constructor(opts = {}) {
      super(opts);
      this._rows = opts.rows || [3, 2, 3];
      this._rowCount = this._rows.length;
      this._resize = this._initGrid.bind(this);
      this._totalCells = this._rows.reduce((a, b) => a + b, 0);
      this._occupied = new Set();
    }

    _initGrid() {
      const { width, height } = Game.elements.container.getBoundingClientRect();
      this._cellW = width / this._rows[0];
      this._cellH = height / this._rowCount;
      const holeSize = Math.min(this._cellW, this._cellH) * 0.80;
      const cont = Game.elements.container;
      cont.style.setProperty('--hole-size', `${holeSize}px`);
      let idx = 1;
      for (let r = 0; r < this._rowCount; r++) {
        const cols = this._rows[r];
        const ground = (r + 1) * this._cellH;
        const xOffset = cols < this._rows[0] ? this._cellW * 0.5 : 0;
        for (let c = 0; c < cols; c++) {
          const x = c * this._cellW + this._cellW * 0.5 + xOffset;
          const left = x - holeSize / 2;
          const top = ground - holeSize / 2;
          cont.style.setProperty(`--hole${idx}-x`, `${left}px`);
          cont.style.setProperty(`--hole${idx}-y`, `${top}px`);
          idx++;
        }
      }
      for (; idx <= 8; idx++) {
        cont.style.setProperty(`--hole${idx}-x`, `-100vw`);
        cont.style.setProperty(`--hole${idx}-y`, `-100vh`);
      }
    }

    spawn() {
      if (Game.state.sprites.length >= cfg.moleCount) return;

      for (let i = 0; i < this._totalCells; i++) {
        const row = Math.floor(Math.random() * this._rowCount);
        const colCount = this._rows[row];
        const col = Math.floor(Math.random() * colCount);
        const key = `${row}:${col}`;
        if (this._occupied.has(key)) continue;

        const r = Math.min(this._cellW, this._cellH) * 0.40;
        const yBase = row * this._cellH;
        const ground = yBase + this._cellH;
        const xOffset = colCount < this._rows[0] ? this._cellW * 0.5 : 0;
        const x = col * this._cellW + this._cellW * 0.5 + xOffset;

        const s = new Game.Sprite({ x, y: ground - r, dx: 0, dy: 0, r, e: Game.utils.pick(cfg.animals), face: 1, dir: 1 });
        s.el.classList.add('mole');
        s.el.style.setProperty('--mole-h', `${r * 2}px`);
        Object.assign(s.el.style, {
          left: `${x - r}px`,
          bottom: `${Game.winH - ground}px`,
          top: 'auto',
          height: '0px'
        });
        s.phase = 'up';
        s.row = row;
        s.col = col;
        s.baseY = ground;
        s.timer = Game.utils.between(cfg.moleStayMin, cfg.moleStayMax) / 1000;
        s.animEnd = () => {
          if (s.phase === 'up') { s.phase = 'stay'; }
          else if (s.phase === 'down') { s.alive = false; }
        };
        s.el.addEventListener('animationend', s.animEnd);
        s.el.style.animation = 'moleRise 0.3s forwards';
        Game.state.sprites.push(s);
        this._occupied.add(key);
        break;
      }
    }

    update(s, dt) {
      if (!s.phase) return;
      if (s.phase === 'stay') {
        s.timer -= dt;
        if (s.timer <= 0) {
          s.phase = 'down';
          s.el.style.animation = 'moleFall 0.3s forwards';
        }
      }
    }

    draw(s) {
      if (!s.alive || !s.phase) return;
      s.el.style.left = `${s.x - s.r}px`;
      s.el.style.bottom = `${Game.winH - s.baseY}px`;
      s.el.style.top = 'auto';
    }

    hit(s) {
      s.pop = 0.01;
      if (s.phase && s.phase !== 'down') {
        Game.burst(s.x, s.y, ['💫']);
        s.phase = 'down';
        s.timer = 0;
        s.el.style.animation = 'moleFall 0.3s forwards';
      }
    }

    setup() {
      Game.cfg.count = cfg.moleCount;
      Game.elements.container.style.display = 'block';
      Game.elements.container.classList.add('mole-bg');
      this._initGrid();
    }

    cleanup() {
      Game.elements.container.classList.remove('mole-bg');
      Game.elements.container.style.display = 'block';
    }

    onRemove(s) {
      if (s.row !== undefined && s.col !== undefined) {
        this._occupied.delete(`${s.row}:${s.col}`);
      }
      if (s.animEnd) s.el.removeEventListener('animationend', s.animEnd);
    }
  }

  Game.registerMode(Game.MODES.MOLE, new MoleGame(cfg));
})(Game);

// Start a random game mode on page load
(function(Game){
  const modes = Object.values(Game.MODES);
  const randomMode = modes[Math.floor(Math.random() * modes.length)];
  Game.setMode(randomMode);
})(Game);
