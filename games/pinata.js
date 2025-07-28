/**
 * Piñata party mini game.
 * The piñata stays on screen and drops candies after a few hits.
 */
(function (g) {
  const SCORE_EL = [
    document.getElementById('teamAScore'),
    document.getElementById('teamBScore')
  ];

  const BASE_AMP = 0.2;
  const BASE_FREQ = 2.0;
  const DECAY_AMP = 0.1;
  const DECAY_FREQ = 0.5;
  const SWING_R = 140;
  const CANDY_GRAVITY = 900;
  const HIT_TO_RAIN = 5;

  g.Game.register('pinata', g.BaseGame.make({
    max: 0, // disable auto spawn
    collisions: false,
    emojis: ['🍬', '🍭', '🍡', '🍫', '🍪', '🧁'],

    onStart() {
      this._hits = 0;
      this.addSprite({
        x: this.W / 2,
        y: this.H * 0.3,
        r: 70,
        e: '🪅',
        type: 'pinata',
        baseX: this.W / 2,
        baseY: this.H * 0.3,
        swingR: SWING_R,
        swingAmp: BASE_AMP,
        swingFreq: BASE_FREQ,
        swingT: 0
      });
    },

    onHit(sp, team) {
      if (sp.type !== 'pinata') return;

      this._hits++;
      this.score[team] += this.calculatePoints(sp);
      if (SCORE_EL[team]) {
        SCORE_EL[team].textContent = `${this.score[team]}`;
      }
      this.emitBurst(sp.x, sp.y, ['✨', '💥', '💫']);

      sp.swingAmp = Math.min(sp.swingAmp + 0.2, 1.3);
      sp.swingFreq = Math.min(sp.swingFreq + 0.7, 5.0);

      if (this._hits >= HIT_TO_RAIN) this._spawnCandies(sp);

      return true; // keep the piñata alive
    },

    move(sp, dt) {
      if (sp.type === 'pinata') {
        sp.swingT += dt;

        if (sp.swingAmp > BASE_AMP) {
          sp.swingAmp = Math.max(BASE_AMP, sp.swingAmp - DECAY_AMP * dt);
        }
        if (sp.swingFreq > BASE_FREQ) {
          sp.swingFreq = Math.max(BASE_FREQ, sp.swingFreq - DECAY_FREQ * dt);
        }

        const phi = sp.swingAmp * Math.sin(sp.swingFreq * sp.swingT);
        sp.angle = phi;
        sp.x = sp.baseX + Math.sin(phi) * SWING_R;
        sp.y = sp.baseY + Math.abs(Math.sin(phi)) * (SWING_R * 0.1);
      } else if (sp.type === 'candy') {
        sp.dy += sp.g * dt;
        sp.x += sp.dx * dt;
        sp.y += sp.dy * dt;
      }
    },

    _spawnCandies(p) {
      const n = 5 + Math.floor(g.R.rand(5));
      for (let i = 0; i < n; i++) {
        const ang = g.R.between(-Math.PI / 3, Math.PI / 3);
        const speed = g.R.between(200, 350);
        this.addSprite({
          x: p.x,
          y: p.y,
          r: g.R.between(20, 32),
          e: g.R.pick(this.cfg.emojis),
          dx: Math.cos(ang) * speed,
          dy: Math.sin(ang) * speed - 200,
          g: CANDY_GRAVITY,
          type: 'candy'
        });
      }
    }
  }));
})(window);
