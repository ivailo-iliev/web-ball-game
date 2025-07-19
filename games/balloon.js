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
    max: BALLOON_MAX,
    emojis: BALLOON_SET,
    spawnEvery: SPAWN_SECS,
    bounceX: false,
    bounceY: false,

    spawn(){
      const r = g.R.between(R_MIN, R_MAX);
      const rare = Math.random() < 0.05;
      const e = rare ? g.R.pick(BALLOON_RARE) : BALLOON_SET[0];
      const x = g.R.between(r, this.W - r);
      const y = this.H + r;
      const dx = g.R.between(-20, 20);
      const dy = -g.R.between(B_V_MIN, B_V_MAX);
      const s = this.addSprite({ x, y, dx, dy, r, e });
      const hue = Math.random() * 360;
      const bri = g.R.between(BRIGHT_MIN, BRIGHT_MAX);
      const sat = g.R.between(SAT_MIN, SAT_MAX);
      s.el.style.filter = `hue-rotate(${hue}deg) brightness(${bri}) saturate(${sat})`;
      return null;
    },

    move(s, dt){
      s.sway = (s.sway || 0) + dt * WOBBLE_FREQ;
      s.x += s.dx * dt + Math.sin(s.sway) * WOBBLE_AMPL;
      s.y += s.dy * dt;
      if(
        s.x < -s.r*2 || s.x > this.W + s.r*2 ||
        s.y < -s.r*2 || s.y > this.H + s.r*2
      ) s.alive = false;
      s.draw();
    }
  }));
})(window);
