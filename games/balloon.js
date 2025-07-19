(function(g){
  const BALLOON_SET  = ['🎈'];
  const BALLOON_RARE = ['☁️','🪁','🦋','⚡','🪙','⭐','🍂'];
  const BALLOON_MAX  = 6;
  const R_MIN        = 25;
  const R_MAX        = 90;
  const B_V_MIN      = 25;
  const B_V_MAX      = 60;
  const WOBBLE_FREQ  = 0.03;
  const WOBBLE_AMPL  = 0.10;
  const SPAWN_SECS   = 0.6;
  const BRIGHT_MIN   = 0.9;
  const BRIGHT_MAX   = 2;
  const SAT_MIN      = 0.9;
  const SAT_MAX      = 1.0;

  g.GameRegister('balloon', g.BaseGame.make({
    theme: 'balloon',
    count: BALLOON_MAX,
    emojis: BALLOON_SET,
    spawnEvery: SPAWN_SECS,
    bounceX: false,
    bounceY: false,

    spawn(){
      const r = g.R.between(R_MIN, R_MAX);
      const face = -1;
      const rare = Math.random() < 0.05;
      const e = rare ? g.R.pick(BALLOON_RARE) : BALLOON_SET[0];
      const x = g.R.between(r, this.W - r);
      const y = this.H + r;
      const dx = g.R.between(-20, 20);
      const dy = -g.R.between(B_V_MIN, B_V_MAX);
      const sp = this.addSprite({ x, y, dx, dy, r, e, face, dir:1 });
      const hue = Math.random() * 360;
      const bri = g.R.between(BRIGHT_MIN, BRIGHT_MAX);
      const sat = g.R.between(SAT_MIN, SAT_MAX);
      sp.el.style.filter = `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
      sp.draw = function(){
        const scale = sp.pop > 0 ? Math.max(0.01, 1 - sp.pop * 4) : 1;
        const rot = Math.sin((sp.x + sp.y) * WOBBLE_FREQ) * WOBBLE_AMPL;
        g.applyTransform(sp.el, sp.x - sp.r, sp.y - sp.r, rot, scale, scale);
      };
    },

    move(s, dt){
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      if(s.pop > 0){
        s.pop += dt;
        if(s.pop > 0.25) s.alive = false;
      }
      if(
        s.x < -s.r*2 || s.x > this.W + s.r*2 ||
        s.y < -s.r*2 || s.y > this.H + s.r*2
      ) s.alive = false;
    },

    onHit(s){
      s.pop = 0.01;
      this.burst(s.x, s.y);
    }
  }));
})(window);
