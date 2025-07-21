(function(g){
  const BALLOON_SET  = ['🎈'];
  const BALLOON_RARE = ['☁️','🪁','🦋','⚡','🪙','⭐','🍂'];
  const BALLOON_MAX  = 6;
  const R_RANGE      = [25, 90];
  const B_V_RANGE    = [25, 60];
  const WOBBLE_FREQ  = 0.03;
  const WOBBLE_AMPL  = 0.10;
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
      const dx = g.R.between(-20, 20);
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
        phase: g.R.rand(Math.PI * 2),
        s: { filter: `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})` }
      };
      return d;
    },

    move(s, dt){
      s.phase = (s.phase || 0) + dt * WOBBLE_FREQ;
      s.x += s.dx * dt;
      s.x += Math.sin(s.phase) * WOBBLE_AMPL;
      s.y += s.dy * dt;
    }
  }));
})(window);
