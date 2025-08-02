(function(g){
  const { rand, between, pick } = g.u;
  const TAU = Math.PI * 2;
  const EMOJIS = ['💎','🏺','🦴','🪙','💰','🗿','🧭','⏳','🔑','🥣','👞','💍','📿','🔔','📯','🍶','🎖️','🩴','👑','🪉'];
  const BURST  = ['💭'];
  const MAX_HITS = 5;
  const R_RANGE = [25, 90];
  const EMOJI_MAX = 6;

  g.Game.register('gem', g.BaseGame.make({
    max            : EMOJI_MAX,
    emojis         : EMOJIS,
    spawnDelayRange: [0, 1],
    burst          : BURST,
    burstN         : 14,

    onStart() {
      const left = document.createElement('div');
      left.className = 'gem-collection left';
      const right = document.createElement('div');
      right.className = 'gem-collection right';
      this.container.appendChild(left);
      this.container.appendChild(right);
      this.collections = [left, right];
    },

    /* create a masked, stationary sprite */
    spawn() {
      return {
        x : rand(this.W),
        y : rand(this.H),
        r: between(...R_RANGE),
        dx: 0,
        dy: 0,
        e : pick(this.emojis),
        hits: 0,
        angle: between(-TAU, TAU),
        p : { '--mr': '0%' }
      };
    },

    /* reveal logic – skip default scoring until fully revealed */
    onHit(s /* sprite */, team) {
      s.hits = (s.hits || 0) + 1;
      if (s.hits < MAX_HITS) {
        const pct = (s.hits / MAX_HITS * 100).toFixed(1) + '%';
        s.style.setProperty('--mr', pct);
        this.emitBurst(s.x, s.y, BURST);
        return true;                  // tell engine we handled the hit
      }
      if (team === 0 || team === 1) {
        const span = document.createElement('span');
        span.textContent = s.e;
        this.collections[team].prepend(span);
      }
      // let the engine proceed with normal scoring & pop
    }
  }));
})(window);
