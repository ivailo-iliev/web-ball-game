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

  const state = {
    sprites: [],
    pending: 0,
    scores: { teamA: 0, teamB: 0 }
  };

  const ModeHandlers = {};
  function registerMode(name, handler) {
    ModeHandlers[name] = handler;
    return handler;
  }

  function buildCfg(mode) {
    return Object.assign({}, baseCfg, ModeHandlers[mode]?.opts || {}, { mode });
  }

  let cfg = buildCfg(baseCfg.mode);

  // DOM elements
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
    Game.winW = winW;
    Game.winH = winH;
  });

  window.addEventListener('orientationchange', () => {
    winW = window.visualViewport.width || window.innerWidth;
    winH = window.visualViewport.height || window.innerHeight;
    Game.winW = winW;
    Game.winH = winH;
  });

  const moleHoles = [];
  function buildMoleBoard(opts = cfg) {
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

    const boardRect = gameContainer.getBoundingClientRect();
    gameContainer._rect = {
      left: boardRect.left,
      top: boardRect.top
    };
    moleHoles.forEach(h => {
      const r = h.getBoundingClientRect();
      h._rect = {
        width: r.width,
        height: r.height,
        left: r.left - boardRect.left,
        top: r.top - boardRect.top
      };
    });
  }

  const rand = n => Math.random() * n;
  const between = (a, b) => a + rand(b - a);
  const randRadius = () => between(cfg.rMin, cfg.rMax);
  const randSpeed = () => between(cfg.vMin, cfg.vMax);
  const randX = r => between(r, winW - r);
  const randY = r => between(r, winH - r);
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
      el.style.setProperty('--life', `${cfg.particleLife}s`);
      el.addEventListener('animationend', () => el.remove(), { once: true });
      gameContainer.appendChild(el);
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
      this.mode = currentMode;

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

      gameContainer.appendChild(this.el);
      this.el._sprite = this;
      this.draw();
    }

    reset() {
      const W = winW, H = winH;
      this.r = randRadius();
      const r = this.r;
      const size = r * 2;
      Object.assign(this.el.style, {
        width: `${size}px`,
        height: `${size}px`,
        lineHeight: `${size}px`,
        fontSize: `${size}px`
      });
      this.x = randX(r);
      this.y = randY(r);
      const { dx, dy } = randVec();
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
      const W = winW, H = winH;
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

  let currentMode = null;

  const spawnTimers = [];
  const DELAY = 3000;

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

  function clearSpawnTimers() { for (const t of spawnTimers) clearTimeout(t); spawnTimers.length = 0; }

  function spawn() { if (currentMode && currentMode.spawn) currentMode.spawn(); }

  const burstTemplate = document.createElement('div');
  burstTemplate.className = 'burst';
  burstTemplate.style.display = 'none';
  gameContainer.appendChild(burstTemplate);

  function burst(x, y, emojiArr = cfg.burst) {
    for (let i = 0; i < cfg.burstN; i++) {
      const sp = 150 + rand(150);
      const { dx: dxp, dy: dyp } = randVec(sp);
      const b = burstTemplate.cloneNode(true);
      b.style.display = 'block';
      b.textContent = emojiArr[Math.floor(rand(emojiArr.length))];
      Object.assign(b.style, { left: `${x}px`, top: `${y}px` });
      b.style.setProperty('--dx', `${dxp}px`);
      b.style.setProperty('--dy', `${dyp}px`);
      gameContainer.appendChild(b);
      b.addEventListener('animationend', () => b.remove(), { once: true });
    }
  }

  const ripple = document.createElement('div');
  ripple.classList.add('ripple');
  gameContainer.appendChild(ripple);

  function maintain() {
    for (let i = state.sprites.length - 1; i >= 0; i--) {
      if (!state.sprites[i].alive) {
        const sp = state.sprites[i];
        if (sp.mode && sp.mode.onRemove) sp.mode.onRemove(sp);
        sp.el.remove();
        state.sprites.splice(i, 1);
      }
    }
    while (state.sprites.length + state.pending < cfg.count) scheduleSpawn();
  }

  for (let i = 0; i < cfg.count; i++) scheduleSpawn();

  const cfgGame = App.Config.get();
  as.className = cfgGame.teamA;
  bs.className = cfgGame.teamB;
  updateScore();

  function updateScore() {
    as.textContent = `${state.scores.teamA}`;
    bs.textContent = `${state.scores.teamB}`;
  }

  function setTeams(a, b) { as.className = a; bs.className = b; }

  function calculatePoints(sprite) {
    const speed = Math.hypot(sprite.dx, sprite.dy);
    const sizeRatio = cfg.rMax / sprite.r;
    const speedRatio = speed / cfg.vMax;
    return Math.max(10, Math.round(sizeRatio * speedRatio * 400));
  }

  function doHit(px, py, team, sprite) {
    Object.assign(ripple.style, { left: `${px}px`, top: `${py}px` });
    ripple.classList.remove('animate');
    void ripple.offsetWidth;
    ripple.classList.add('animate');

    const targets = sprite ? [sprite] : state.sprites;
    for (const s of targets) {
      if (s.alive && (!sprite ? s.contains(px, py) : true) && s.pop === 0) {
        s.doHit();
        state.scores[team] += calculatePoints(s);
        updateScore();
        break;
      }
    }
  }

  function preventContextMenu(e) { e.preventDefault(); }
  function addInputListeners() { window.addEventListener('contextmenu', preventContextMenu); }
  function removeInputListeners() { window.removeEventListener('contextmenu', preventContextMenu); }
  addInputListeners();

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
    cfg,
    state,
    utils: { rand, between, randRadius, randSpeed, randX, randY, randVec, pick, applyTransform },
    elements: { container: gameContainer },
    winW,
    winH,
    Sprite,
    setTeams,
    setMode,
    spawn,
    burst,
    registerMode,
    GameMode,
    buildCfg,
    moleHoles,
    buildMoleBoard
  };

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
    moleGridCols: 5,
    moleGridRows: 3,
    moleUpV: 350,
    moleStayMin: 1000,
    moleStayMax: 3000,
    moleCount: 12,
    animals: ['🐭','🐰']
  };

  class MoleGame extends Game.GameMode {
    spawn() {
      if (Game.state.sprites.length >= cfg.moleCount) return;
      const freeHoles = Game.moleHoles.filter(h => !h.dataset.busy);
      if (freeHoles.length === 0) return;
      const hole = Game.utils.pick(freeHoles);
      hole.dataset.busy = '1';
      const rect = hole._rect;
      const r = Math.min(rect.width, rect.height) * 0.40;
      const x = rect.width * 0.5;
      const y = rect.height + r;
      const dx = 0;
      const dy = -cfg.moleUpV;
      const e = Game.utils.pick(cfg.animals);
      const s = new Game.Sprite({ x, y, dx, dy, r, e, face:1, dir:1 });
      s.hole = hole;
      s.phase = 'up';
      s.timer = Game.utils.between(cfg.moleStayMin, cfg.moleStayMax) / 1000;
      s.el.remove();
      hole.appendChild(s.el);
      Game.state.sprites.push(s);
    }
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
    }
    draw(s) {
      if (!s.alive) return;
      Game.utils.applyTransform(s.el, s.x - s.r, s.y - s.r, 0, 1, 1);
    }
    hit(s) {
      s.pop = 0.01;
      if (s.phase && s.phase !== 'down') {
        const game = Game.elements.container._rect;
        const hole = s.hole._rect;
        const gx = s.x + hole.left - game.left;
        const gy = s.y + hole.top - game.top;
        Game.burst(gx, gy, ['💫']);
        s.phase = 'down';
        s.dy = cfg.moleUpV;
        s.timer = 0;
      }
    }
    contains(s, px, py) {
      const game = Game.elements.container._rect;
      const hole = s.hole._rect;
      px -= hole.left - game.left;
      py -= hole.top - game.top;
      return (px - s.x) ** 2 + (py - s.y) ** 2 <= s.r ** 2;
    }
    setup() {
      Game.cfg.count = cfg.moleCount;
      Game.buildMoleBoard(cfg);
    }
    cleanup() {
      document.querySelectorAll('.moleHole').forEach(h => h.remove());
      Game.elements.container.style.display = 'block';
    }
    onRemove(s) {
      if (s.hole) s.hole.dataset.busy = '';
    }
  }

  Game.registerMode(Game.MODES.MOLE, new MoleGame(cfg));
})(Game);
