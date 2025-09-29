(function(g){
  const { pick } = g.u;
  const RIDER_LIFETIME_SECS = 32;
  const RIDER_MAX = 8;
  const RIDER_EMOJIS = ['😄','😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','🙂','🙃','😉','😍','🥰','😘','😗','😙','😚','🤩','🥳','😎','🤗','🤭','😺','😸','😹','😻','😼','😽','🥳'];
  const SPAWN_DELAY_RANGE = [0, 0.5];

  // Performance + control
  const TAU = Math.PI * 2;
  const DURATION_MS = 12000;      // 1 revolution (slower ⇒ fewer spawn/exit churn events)
  const BOARD_GAP_TURNS = 0.02;   // debounce boarding (once per bottom pass)
  const N_SEATS = 8;
  const RADIUS = 150;             // px; matches --r in CSS
  const INSET  = 5;              // nudge inward so riders sit “in” the cart
  const RIDER_R = 20;             // emoji visual radius (approx half of cart height 70px)
  const BOTTOM = TAU * 0.25;      // screen-down angle

  g.Game.register('ferris', g.BaseGame.make({
    icon: '🎡',
    max: RIDER_MAX,
    emojis: RIDER_EMOJIS,
    burst: ['💫'],
    spawnDelayRange: SPAWN_DELAY_RANGE,

    onStart(){
      // Decorative queue
      const q = document.createElement('div');
      q.className = 'queue';
      this.container.appendChild(q);
      let qs = 0;
      const { style: qStyle } = q;
      this._tickQueue = () => {
        qs += 1;                        // advance by one step
        qStyle.setProperty('--n', qs);
        qStyle.setProperty('--m', qs + 1);
      };

      // Inject SVG wheel
      const svgString = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <radialGradient id="wheelGradient" cx="256" cy="256" r="220" gradientUnits="userSpaceOnUse">
      <stop offset="0%" stop-color="#ff0040"/>
      <stop offset="16%" stop-color="#ffa500"/>
      <stop offset="32%" stop-color="#ffff00"/>
      <stop offset="48%" stop-color="#00ff00"/>
      <stop offset="64%" stop-color="#00bfff"/>
      <stop offset="80%" stop-color="#7a00ff"/>
      <stop offset="100%" stop-color="#ff00ff"/>
    </radialGradient>
    <symbol id="cart" viewBox="0 0 78 68">
      <path class="c1" d="M17 0c-6 0-7 5-8 10L3 43h72L70 9c-1-5-2-8-8-9H17Z"/>
      <path class="c2" d="M0 56c-1 6 5 12 8 12h61c5 0 9-3 8-10l-2-15H3L0 56Z"/>
    </symbol>
  </defs>

  <!-- background shapes (simplified geometry preserved) -->
  <!--<g>
    <path fill="#7956c0" d="M-16 193 98-60l25-128-28-21L39-39l-162 248 107-16Z"
          transform="matrix(.47 0 0 .47 193.13 394.56)"/>
    <path fill="#7956c0" d="M-128-173c1 15 35 129 35 129L33 207l95 3L-52-51l-55-159-21 37Z"
          transform="matrix(.47 0 0 .47 320.03 389.39)"/>
    <path fill="#8f7cf3" d="M-120 190c7-7 163-249 163-249l55-154 24 28L90-52-85 211l-37 2 2-23Z"
          transform="matrix(.47 0 0 .47 187.02 390.80)"/>
    <path fill="#8f7cf3" d="m-130-191 41 138L88 212l42-4L-48-62l-58-150-24 21Z"
          transform="matrix(.47 0 0 .47 327.08 391.74)"/>
    <path fill="#8f7cf3" d="M-326-28c-7 7-4 54 1 56 3 1 159 2 321 2s328 2 331 0c6-2 5-52 0-56-2-3-166-3-329-4-162-1-320-2-324 2Z"
          transform="matrix(.47 0 0 .47 258.46 495.14)"/>
  </g>-->
  <text class="base" font-size="400" x="50%" y="400" text-anchor="middle" dominant-baseline="middle" fill="#8f7cf3" stroke="#7956c0" stroke-width="20" stroke-linejoin="round" paint-order="stroke fill">⧍</text>

  <!-- wheel -->
  <g class="wheel">
    <path fill="none" stroke="url(#wheelGradient)" stroke-linecap="round" stroke-dasharray="2 10" stroke-width="10"
      d="M256 73v185l130-131-130 131h184-184l130 130-130-130v184-184L126 388l130-130H72h184L126 127l130 131Zm0 0a184 184 0 0 0 0 369 184 184 0 0 0 0-369"/>
    <path fill="none" stroke="url(#wheelGradient)" stroke-linecap="round" stroke-dasharray="2 10" stroke-width="10"
      d="m256 78 48 63 79-11-11 79 64 49-64 48 11 79-79-11-48 63-48-63-79 11 11-79-64-48 64-49-11-79 79 11Zm0 59a120 120 0 0 0 0 241 120 120 0 0 0 0-241"/>
  </g>

  <!-- hub -->
  <text class="hub" font-size="120" line-ieight="100" x="50%" y="52%" text-anchor="middle" dominant-baseline="middle">🌟</text>

  <!-- 8 carts -->
  <g class="ferris-carts">
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
    <use href="#cart" width="80" height="70" x="216" y="246"/>
  </g>
</svg>`;

      const { documentElement: svgRoot } =
        new DOMParser().parseFromString(svgString, "image/svg+xml");
      svgRoot.setAttribute('width', '100vmin');
      svgRoot.setAttribute('height', '100vmin');
      const wheel = document.importNode(svgRoot, true);
      this.container.appendChild(wheel);

      // ── single clock: animate --spin on container (inherited by SVG -> .wheel)
      this.spin = this.container.animate(
        { '--spin': ['0deg','360deg'] },
        { duration: DURATION_MS, iterations: Infinity, easing: 'linear' }
      );
      this.turns = () => (this.spin.currentTime % DURATION_MS) / DURATION_MS; // 0..1

      // ── seat model (math only; no DOM reads)
      this.N = N_SEATS;
      this.step = Math.PI * 2 / this.N;
      this.carts = Array.from({ length: this.N }, (_, i) => ({
        index: i,
        c0: Math.cos(i * this.step),
        s0: Math.sin(i * this.step),
        occupied: false,
        lastBoardTurn: -1
      }));

      // viewport-locked center (no resize support)
      this.cx = this.container.clientWidth  / 2;
      this.cy = this.container.clientHeight / 2;

      // micro-opt cache: cos/sin/angle/turn computed once per frame
      this._lastTime = -1;
      this._A = 0; this._cos = 1; this._sin = 0; this._turn = 0;

      // local helpers
      const mod = (n, m) => ((n % m) + m) % m;

      this._updateFrameTrigs = () => {
        const t = this.spin.currentTime;
        if (t === this._lastTime) return;  // same animation frame: reuse values
        this._lastTime = t;
        this._turn = this.turns();
        this._A = this._turn * Math.PI * 2;
        this._cos = Math.cos(this._A);
        this._sin = Math.sin(this._A);
      };

      this._seatPos = (idx) => {
        const seat = this.carts[idx];
        const vx = seat.c0 * this._cos - seat.s0 * this._sin;
        const vy = seat.s0 * this._cos + seat.c0 * this._sin;
        const r = (RADIUS - INSET);
        return { x: this.cx + r * vx, y: this.cy + r * vy };
      };

      this._bottomIndex = () => mod(Math.round((BOTTOM - this._A) / this.step), this.N);
    },


    spawn(){
      // board only when the bottom cart is free
      if (!this.carts || !this.carts.length) return null;
      this._updateFrameTrigs();

      const idx = this._bottomIndex();
      const cart = this.carts[idx];
      const canBoard = cart && !cart.occupied && (this._turn - cart.lastBoardTurn) > BOARD_GAP_TURNS;
      if (!canBoard) return null;

      cart.occupied = true;
      cart.lastBoardTurn = this._turn;
      this._tickQueue();

      const p = this._seatPos(idx);
      return {
        x: p.x,
        y: p.y + RIDER_R,
        dx: 0, dy: 0,
        r: RIDER_R,
        e: pick(this.emojis),
        ttl: RIDER_LIFETIME_SECS,
        cartIndex: idx
      };
    },

    move(s, dt){
      // keep riders glued to their cart position; upright
      if (s.cartIndex === undefined) return;
      this._updateFrameTrigs();
      const p = this._seatPos(s.cartIndex);
      s.x = p.x;
      s.y = p.y + s.r;
      s.angle = 0;
    },

    onHit(sp, team){
      const cart = this.carts[sp.cartIndex];
      if (cart) cart.occupied = false;
    },

    onMiss(sp){
      const cart = this.carts[sp.cartIndex];
      if (cart) cart.occupied = false;
    }

  }));
})(window);
