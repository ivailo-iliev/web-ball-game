(function(g){
  const FISH_SET = ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'];
  const FISH_MAX = 6;
  const SPAWN_DELAY_RANGE = [0, 3];
  const R_RANGE = [25, 90];
  const V_RANGE = [10, 180];

  g.Game.register('fish', g.BaseGame.make({
    max: FISH_MAX,
    emojis: FISH_SET,
    burst: ['🫧'],
    spawnDelayRange: SPAWN_DELAY_RANGE,
    bounceY: true,

    spawn(){
      const r = g.R.between(...R_RANGE);
      const swimRight = Math.random() < 0.5;
      const speed = g.R.between(...V_RANGE);
      const dx = swimRight ? speed : -speed;
      const x = swimRight ? -r : this.W + r;
      const y = g.R.between(r, this.H - r);
      const dy = g.R.between(-20, 20);
      const d = {
        x,
        y,
        dx,
        dy,
        r,
        e: g.R.pick(this.emojis),
        scaleX: swimRight ? -1 : 1,
        p: { '--flyX': swimRight ? '120vw' : '-120vw' }
      };
      return d;
    },

    move(s, dt){
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
