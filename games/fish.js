(function(g){
  const { rand, between, pick } = g.R;
  const TAU = Math.PI * 2;
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
      const r = between(...R_RANGE);
      const swimRight = rand(1) < 0.5;
      const speed = between(...V_RANGE);
      const dx = swimRight ? speed : -speed;
      const x = swimRight ? -r : this.W + r;
      const y = between(r, this.H - r);
      const dy = between(-10, 10);
      const d = {
        x,
        y,
        dx,
        dy,
        r,
        e: pick(this.emojis),
        scaleX: swimRight ? -1 : 1,
        p: { '--flyX': swimRight ? '120vw' : '-120vw' }
      };
      return d;
    },

    move(s, dt){
      s.x += s.dx * dt;
      s.y += s.dy * dt;
    }
  }));
})(window);
