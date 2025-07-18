(function(g){
  const FISH_SET = ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'];
  const FISH_MAX = 6;
  const SPAWN_SECS = 0.6;
  const R_MIN = 25;
  const R_MAX = 90;
  const V_MIN = 10;
  const V_MAX = 180;

  g.Game.register('fish', g.BaseGame.make({
    max: FISH_MAX,
    emojis: FISH_SET,
    burst: ['🫧'],
    spawnEvery: SPAWN_SECS,
    bounceY: true,

    spawn(){
      const r = g.R.between(R_MIN, R_MAX);
      const fromLeft = Math.random() < 0.5;
      const x = fromLeft ? -r : this.W + r;
      const y = g.R.between(r, this.H - r);
      const dx = (fromLeft ? 1 : -1) * g.R.between(V_MIN, V_MAX);
      const dy = g.R.between(-20, 20);
      const sp = this.addSprite({ x, y, dx, dy, r, e: g.R.pick(this.emojis), hp:1 });
      if (dx < 0) sp.el.style.scale = '-1 1';
      return null;
    },

    move(s, dt){
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      if((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > this.H && s.dy > 0)) s.dy *= -1;
      if(
        s.x < -s.r*2 || s.x > this.W + s.r*2 ||
        s.y < -s.r*2 || s.y > this.H + s.r*2
      ) s.remove();
      s.draw();
    },

    onHit(_s){
    }
  }));
})(window);
