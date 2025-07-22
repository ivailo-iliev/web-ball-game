(function(g){
  const BALLOON_SET  = ['🎈'];
  const BALLOON_RARE = ['☁️','🪁','🦋','⚡','🪙','⭐','🍂'];
  const BALLOON_MAX  = 6;
  const R_RANGE      = [25, 90];
  const B_V_RANGE    = [25, 60];
  const ROT_FREQ  = 0.03;
  const ROT_AMPL  = 0.10;
  const SPAWN_DELAY_RANGE = [0, 3];
  const BRIGHT_RANGE = [0.9, 2];
  const SAT_RANGE    = [0.9, 1.0];

  g.Game.register('balloon', g.BaseGame.make({
    max: BALLOON_MAX,
    emojis: BALLOON_SET,
    spawnDelayRange: SPAWN_DELAY_RANGE,

    spawn(){
      const r = g.R.between(...R_RANGE);
      const rare = Math.random() < 0.05;
      const e = rare ? g.R.pick(BALLOON_RARE) : BALLOON_SET[0];
      const x = g.R.between(r, this.W - r);
      const y = this.H + r;
      const dx = g.R.between(-10, 10);
      const dy = -g.R.between(...B_V_RANGE);
      const hue = Math.random() * 360;
      const bri = g.R.between(...BRIGHT_RANGE);
      const sat = g.R.between(...SAT_RANGE);
      const d = {
        x,
        y,
        dx,
        dy,
        r,
        e,
        s: { filter: `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})` }
      };
      return d;
    },

    move(s, dt){
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      s.angle = Math.sin((s.x + s.y) * ROT_FREQ) * ROT_AMPL;
    }
  }));
})(window);
