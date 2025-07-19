(function(g){
  const FISH_SET = ['🐳','🐋','🐬','🦭','🐟','🐠','🦈','🐙','🪼','🦀','🦞','🦐'];
  const BUBBLE_SET = ['🫧'];
  const FISH_MAX = 6;
  const SPAWN_SECS = 0.6;

  g.GameRegister('fish', g.BaseGame.make({
    theme: 'ocean',
    count: FISH_MAX,
    emojis: FISH_SET,
    spawnEvery: SPAWN_SECS,
    bounceX: false,
    bounceY: true,

    spawn(){
      const r = g.R.between(this.cfg.rMin, this.cfg.rMax);
      const fromLeft = Math.random() < 0.5;
      const face = fromLeft ? 1 : -1;
      const x = fromLeft ? -r : this.W + r;
      const y = g.R.between(r, this.H - r);
      const dx = face * g.R.between(this.cfg.vMin, this.cfg.vMax);
      const dy = g.R.between(-20, 20);
      const dir = -face;
      const sp = this.addSprite({ x, y, dx, dy, r, e: g.R.pick(this.emojis), face, dir, angle: 0, pop:0 });
      sp.draw = function(){
        g.applyTransform(sp.el, sp.x - sp.r, sp.y - sp.r, sp.angle || 0, sp.face>0?-1:1, 1);
      };
    },

    move(s, dt){
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      if(s.pop > 0){
        s.pop += dt;
        s.angle += dt * this.cfg.spin * s.dir;
        s.dx *= 1.25;
      } else {
        if((s.y - s.r < 0 && s.dy < 0) || (s.y + s.r > this.H && s.dy > 0)) s.dy *= -1;
      }
      if(
        s.x < -s.r*2 || s.x > this.W + s.r*2 ||
        s.y < -s.r*2 || s.y > this.H + s.r*2
      ) s.alive = false;
      s.draw();
    },

    onHit(s){
      s.el.classList.add('spin');
      this.burst(s.x, s.y, BUBBLE_SET);
    }
  }));
})(window);
