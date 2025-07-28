(function(g){
  const EMOJIS = ['💎','🏺','🦴','🪙','💰','🗿','🧭','⏳','🗝️','🥣','👞','💍','📿','🔔','📯','🍶','🎖️'];
  const BURST  = ['💭'];
  const MAX_HITS = 5;

  g.Game.register('gem', g.BaseGame.make({
    max            : 6,
    emojis         : EMOJIS,
    spawnDelayRange: [0, 0],
    collisions     : false,
    bounceX        : false,
    bounceY        : false,
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

    /* reveal logic – skip base scoring / popping until fully revealed */
    onHit(s /* sprite */, team) {
      s.hits = (s.hits || 0) + 1;
      if (s.hits < MAX_HITS) {
        const pct = (s.hits / MAX_HITS * 100).toFixed(1) + '%';
        s.style.setProperty('--mr', pct);
        /* <<< returning true tells the engine we handled the hit; no pop */
        return true;
      }
      /* once hits === MAX_HITS we fall through → engine scores & pops */
    }
  }));
})(window);
