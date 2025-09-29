(function(g){
  const { pick } = g.u;
  const RIDER_LIFETIME_SECS = 32;
  const RIDER_MAX = 8;
  const RIDER_EMOJIS = ['😄','😀','😃','😄','😁','😆','😅','😂','🤣','🥲','😊','🙂','🙃','😉','😍','🥰','😘','😗','😙','😚','🤩','🥳','😎','🤗','🤭','😺','😸','😹','😻','😼','😽','🥳'];
  const SPAWN_DELAY_RANGE = [0, 3];
  const ROT_FREQ  = 0.03;
  const ROT_AMPL  = 0.10;

  g.Game.register('ferris', g.BaseGame.make({
    icon: '🎡',
    max: RIDER_MAX,
    emojis: RIDER_EMOJIS,
    burst: ['💫'],
    spawnDelayRange: SPAWN_DELAY_RANGE,

    onStart(){
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
  <g>
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
  </g>

  <!-- wheel -->
  <g class="wheel">
    <path fill="none" stroke="url(#wheelGradient)" stroke-linecap="round" stroke-dasharray="2 18" stroke-width="9.2"
      d="M256 73v185l130-131-130 131h184-184l130 130-130-130v184-184L126 388l130-130H72h184L126 127l130 131Zm0 0a184 184 0 0 0 0 369 184 184 0 0 0 0-369"/>
    <path fill="none" stroke="url(#wheelGradient)" stroke-linecap="round" stroke-dasharray="2.5 20" stroke-width="11"
      d="m256 78 48 63 79-11-11 79 64 49-64 48 11 79-79-11-48 63-48-63-79 11 11-79-64-48 64-49-11-79 79 11Zm0 59a120 120 0 0 0 0 241 120 120 0 0 0 0-241"/>
  </g>

  <!-- hub -->
  <text class="hub" font-size="90" x="50%" y="50%" text-anchor="middle" dominant-baseline="middle">🌟</text>

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

      this.carts = Array.from(wheel.querySelectorAll('.ferris-carts use'), el => ({
        el,
        occupied: false,
        x: 0,
        y: 0
      }));
      this.cartR = 0;
      this.bottomIndex = -1;

      this._updateCartPositions = () => {
        const { carts } = this;
        if (!carts.length) return;

        const containerRect = this.container.getBoundingClientRect();
        let maxHeight = 0;
        let bottomIdx = -1;
        let bottomY = -Infinity;
        for (let i = 0; i < carts.length; i += 1) {
          const cart = carts[i];
          const rect = cart.el.getBoundingClientRect();
          const x = rect.left - containerRect.left + rect.width * 0.5;
          const y = rect.bottom - containerRect.top - rect.height * 0.18;
          cart.x = x;
          cart.y = y;
          if (rect.height > maxHeight) maxHeight = rect.height;
          if (y > bottomY) {
            bottomY = y;
            bottomIdx = i;
          }
        }
        if (maxHeight) {
          this.cartR = maxHeight * 0.5;
        }
        this.bottomIndex = bottomIdx;
      };

      this._updateCartPositions();
    },


    spawn(){
      this._updateCartPositions();
      if (!this.cartR) return null;
      const idx = this.bottomIndex;
      const cart = this.carts[idx];
      if (!cart || cart.occupied) return null;
      cart.occupied = true;
      this._tickQueue();

      const d = {
        x: cart.x,
        y: cart.y - this.cartR,
        dx: 0,
        dy: 0,
        r: this.cartR,
        e: pick(this.emojis),
        ttl: RIDER_LIFETIME_SECS,
        cartIndex: idx,
      };
      return d;
    },

    move(s, dt){
      this._updateCartPositions();

      const cart = this.carts[s.cartIndex];
      if (cart) {
        const radius = this.cartR || s.r;
        s.x = cart.x;
        s.y = cart.y - radius;
      } else {
        s.x += s.dx * dt;
        s.y += s.dy * dt;
      }
      s.angle = Math.sin((s.x + s.y) * ROT_FREQ) * ROT_AMPL;
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
