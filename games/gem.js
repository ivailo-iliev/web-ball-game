(function(g){
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

    /* create a masked, stationary sprite */
    spawn() {
      return {
        x : g.R.rand(this.W),
        y : g.R.rand(this.H),
        r: g.R.between(...R_RANGE),
        dx: 0,
        dy: 0,
        e : g.R.pick(this.emojis),
        hits: 0,
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
      // let the engine proceed with normal scoring & pop
    }
  }));
})(window);
