(function(g){
  const { between, pick, rand } = g.u;
  const TAU = Math.PI * 2;

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
    icon: BALLOON_SET[0],
    max: BALLOON_MAX,
    emojis: BALLOON_SET,
    spawnDelayRange: SPAWN_DELAY_RANGE,

    spawn(){
      const r = between(...R_RANGE);
      const rare = rand(1) < 0.05;
      const e = rare ? pick(BALLOON_RARE) : BALLOON_SET[0];
      const x = between(r, this.W - r);
      const y = this.H + r;
      const dx = between(-10, 10);
      const dy = -between(...B_V_RANGE);
      const hue = rand(360);
      const bri = between(...BRIGHT_RANGE);
      const sat = between(...SAT_RANGE);
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
