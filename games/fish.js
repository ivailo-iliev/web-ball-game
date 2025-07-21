(function(g){
  const FISH_SET = ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'];
  const FISH_MAX = 6;
  const SPAWN_DELAY_MIN = 0;
  const SPAWN_DELAY_MAX = 3;
  const R_MIN = 25;
  const R_MAX = 90;
  const V_MIN = 10;
const V_MAX = 180;
const WOBBLE_AMPL = 0.10;
const WOBBLE_FREQ = 0.03;

  g.Game.register('fish', g.BaseGame.make({
    max: FISH_MAX,
    emojis: FISH_SET,
    burst: ['🫧'],
    spawnDelayMin: SPAWN_DELAY_MIN,
    spawnDelayMax: SPAWN_DELAY_MAX,
    bounceY: true,

    spawn(){
      const r     = g.R.between(R_MIN, R_MAX);
      const right = Math.random() < 0.5 ? 1 : -1; // 1 → swim right
      const speed = g.R.between(V_MIN, V_MAX);
      const dx    = right * speed;
      const x     = right > 0 ? -r : this.W + r;
      const y     = g.R.between(r, this.H - r);
      const dy    = g.R.between(-20, 20);

      const desc = {
        x,
        y,
        dx,
        dy,
        r,
        e: g.R.pick(this.emojis),
        hp: 1,
        phase: g.R.rand(Math.PI * 2),
        p: { '--flyX': right > 0 ? '120vw' : '-120vw' }
      };
      if (right > 0) desc.s = { scale: '-1 1' };
      return desc;
    },

    move(s, dt){
      s.phase = (s.phase || 0) + dt * WOBBLE_FREQ;
      s.y += Math.sin(s.phase) * WOBBLE_AMPL;
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      if ((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > this.H && s.dy > 0)) {
        s.dy *= -1;
      }
      if (s.y - s.r < 0) s.y = s.r;
      if (s.y + s.r > this.H) s.y = this.H - s.r;
    }
  }));
})(window);
