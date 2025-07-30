/**
 * Piñata party mini game.
 * The piñata stays on screen and drops candies after a few hits.
 */

(function (g) {
  'use strict';
  const { rand, between, pick } = g.R;
  const TAU = Math.PI * 2;

  const SCORE_EL = [
    document.getElementById('teamAScore'),
    document.getElementById('teamBScore')
  ];

  const BASE_AMP = 0.2; // radians
  const BASE_FREQ = 2.0; // radians per second
  const DECAY_AMP = 0.15; // slower decay → smoother ease-out
  const DECAY_FREQ = 0.15;
  const STRING = 200;     // px – matches :root{ --string } in CSS
  const CANDY_GRAVITY = 900;
  const HIT_TO_RAIN = 5;

  g.Game.register('pinata', g.BaseGame.make({
    max: 0, // disable auto spawn
    collisions: false,
    emojis: ['🍬', '🍭', '🍡', '🍫', '🍪', '🧁'],

    onStart() {
      this._hits = 0;
      const pivotX = this.W / 2;
      const pivotY = this.H / 2;
      const sp = this.addSprite({
        x: pivotX,
        y: pivotY,
        r: 70,
        e: '🪅',
        type: 'pinata',
        swingAmp: BASE_AMP,
        swingFreq: BASE_FREQ,
        phase: 0,                 // oscillator phase (rad)
        pivotX,
        pivotY
      });
      sp.el.classList.add('pinata');
      /* No inline style writes – engine’s draw() will use x, y, angle */
    },

    onHit(sp, team) {
      if (sp.type !== 'pinata') return;

      this._hits++;
      const score = (this.score[team] += this.calculatePoints(sp));
      if (SCORE_EL[team]) {
        SCORE_EL[team].textContent = `${score}`;
      }
      this.emitBurst(sp.x, sp.y, ['✨', '💥', '💫']);

      sp.swingAmp  = Math.min(sp.swingAmp  + 0.2, 1.3);
      sp.swingFreq = Math.min(sp.swingFreq + 0.7, 5.0);
      /* transform will update next frame */

      if (this._hits >= HIT_TO_RAIN) this._spawnCandies(sp);

      return true; // keep the piñata alive
    },

    move(sp, dt) {
      if (sp.type === 'pinata') {
        /* 1 . ease back toward idle values */
        sp.swingAmp  += (BASE_AMP  - sp.swingAmp)  * DECAY_AMP  * dt;
        sp.swingFreq += (BASE_FREQ - sp.swingFreq) * DECAY_FREQ * dt;

        /* 2 . integrate the oscillator */
        sp.phase += sp.swingFreq * dt;
        const sinP = Math.sin(sp.phase);
        const cosP = Math.cos(sp.phase);

        /* 3 . expose angle for Sprite.draw() */
        sp.angle = sp.swingAmp * sinP;

        /* 4 . logical centre for hit-tests (no DOM reads each frame) */
        sp.x = sp.pivotX + sinP * STRING;
        sp.y = sp.pivotY + (1 - cosP) * STRING;
      } else if (sp.type === 'candy') {
        sp.dy += sp.g * dt;
        sp.x += sp.dx * dt;
        sp.y += sp.dy * dt;

        const ground = this.H - sp.r;
        if (sp.y > ground) {
          sp.y = ground;
          if (!sp.settled) {
            sp.dy *= -0.4;
            sp.dx *= 0.5;
            if (Math.abs(sp.dy) < 50) {
              sp.dy = 0;
              sp.dx = 0;
              sp.g = 0;
              sp.settled = true;
            }
          }
        }
      }
    },

    _spawnCandies(p) {
      const n = 5 + Math.floor(rand(5));
      for (let i = 0; i < n; i++) {
        const ang = between(-TAU / 6, TAU / 6);
        const speed = between(200, 350);
        const dir = rand(1) < 0.5 ? -1 : 1;
        this.addSprite({
          x: p.x,
          y: p.y,
          r: between(20, 32),
          e: pick(this.cfg.emojis),
          dx: Math.cos(ang) * speed * dir,
          dy: Math.sin(ang) * speed - 200,
          g: CANDY_GRAVITY,
          type: 'candy'
        });
      }
    }
  }));
})(window);
