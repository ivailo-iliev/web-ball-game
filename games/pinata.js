/**
 * Cleaner, self‑contained Piñata mini‑game.
 *
 *  ➜ No global temporaries (everything hangs off the game instance)
 *  ➜ Consolidated constants and helper functions
 *  ➜ Debug overlay isolated behind a single flag
 *  ➜ Pinata update logic extracted for clarity
 */

(function (g) {
  'use strict';

  /* ------------------------------------------------------------
   *  CONSTANTS
   * ---------------------------------------------------------- */
  const { rand, between, pick } = g.u;
  const TAU = Math.PI * 2;

  // Tune‑once gameplay knobs
  const CFG = Object.freeze({
    BASE_AMP: 0.20,      // rad — idle swing half‑amplitude
    BASE_FREQ: 2.0,      // rad · s⁻¹ — idle angular velocity
    DECAY: 0.15,         // (0–1) spring‑like ease back to idle
    STRING: 200,         // px — must match :root{ --string } in CSS
    CANDY_GRAVITY: 900,  // px · s⁻²
    HIT_TO_CANDY: 5,     // hits before the piñata bursts
    PINATA_R: 70,        // px — emoji rendered size / 2
    CANDY_N_RANGE: [3, 6],         // candies per burst
    CANDY_ANG: TAU / 6,            // rad — half spread angle
    CANDY_SPEED_RANGE: [200, 350], // px·s⁻¹
    CANDY_R_RANGE: [20, 32],       // px — candy size
    CANDY_UP: 200                  // px·s⁻¹ vertical boost
  });

  // Quick lookup aliases
  const {
    BASE_AMP,
    BASE_FREQ,
    DECAY,
    STRING,
    CANDY_GRAVITY,
    HIT_TO_CANDY,
    PINATA_R,
    CANDY_N_RANGE,
    CANDY_ANG,
    CANDY_SPEED_RANGE,
    CANDY_R_RANGE,
    CANDY_UP
  } = CFG;

  // Visual troubleshooting — toggle while developing
  const DEBUG = false; // ← flip to true to draw the hit‑centre dot


  /* ------------------------------------------------------------
   *  Helper: spawn a floating debug dot
   * ---------------------------------------------------------- */
  function createDebugDot(layer) {
    const el = document.createElement('div');
    el.className = 'debug-dot';
    layer.appendChild(el);
    return el;
  }

  /* ------------------------------------------------------------
   *  Game definition
   * ---------------------------------------------------------- */
  g.Game.register('pinata', g.BaseGame.make({
    icon: '🪅',
    max: 0,            // disable auto‑spawn from engine
    collisions: false, // no sprite–sprite collisions
    emojis: ['🍬', '🍭', '🍡', '🍫', '🍪', '🧁'],
    pinatas: ['🪅', '🧸', '🦄', '🦙'],

    /* --------------------------------------------------------
     *  Setup — runs once
     * ------------------------------------------------------ */
    onStart() {
      this.hits = 0;

      // Create one piñata hanging from the ceiling centre
      const pivotX = this.W / 2;
      const pivotY = 0;

      const sp = this.addSprite({
        type: 'pinata',
        e: pick(this.pinatas),
        r: PINATA_R,
        // logical centre starts STRING px below the pivot
        x: pivotX,
        y: pivotY + STRING,
        // swing state
        swingAmp: BASE_AMP,
        swingFreq: BASE_FREQ,
        phase: 0,
        // rope knot location (immutable)
        pivotX,
        pivotY,
        // expose CSS var for the transform‑origin offset
        p: { '--string': `${STRING}px` }
      });
      sp.el.classList.add('pinata');

      /* Custom draw: keep the knot bolted to (pivotX,pivotY)
         and let rotation make the emoji swing. */
      sp.draw = function () {
        const tx = this.pivotX - this.r;
        const ty = this.pivotY - this.r + STRING;
        this.style.transform =
          `translate3d(${tx}px, ${ty}px, 0)` +
          ` rotate(${this.angle}rad)` +
          ` scale(${this.scaleX}, ${this.scaleY})`;
      };

      // Optional debug overlay
      if (DEBUG) {
        sp.debugDot = createDebugDot(this.container);
      }

      this.pinata = sp; // cache handle for clarity
    },

    /* --------------------------------------------------------
     *  Per‑frame logic
     * ------------------------------------------------------ */
    move(sp, dt) {
      if (sp.type === 'pinata') {
        this._updatePinata(sp, dt);
      } else if (sp.type === 'candy') {
        this._updateCandy(sp, dt);
      }
    },

    /* ---------------- Pinata physics & feedback ------------ */
    _updatePinata(sp, dt) {
      /* 1. Ease swing amplitude/frequency back toward idle */
      sp.swingAmp += (BASE_AMP - sp.swingAmp) * DECAY * dt;
      sp.swingFreq += (BASE_FREQ - sp.swingFreq) * DECAY * dt;

      /* 2. Integrate phase */
      sp.phase += sp.swingFreq * dt;

      /* 3. Final angle for this frame */
      sp.angle = sp.swingAmp * Math.sin(sp.phase);

      /* 4. Logical centre (used for hit testing) */
      const sinA = Math.sin(sp.angle);
      const cosA = Math.cos(sp.angle);
      const { pivotX, pivotY } = sp;
      sp.x = pivotX - sinA * STRING;
      sp.y = pivotY + cosA * STRING;

      /* 5. Debug dot follows logical centre */
      if (DEBUG && sp.debugDot) {
        sp.debugDot.style.transform =
          `translate3d(${sp.x}px, ${sp.y}px, 0) translate(-50%, -50%)`;
      }
    },

    /* ---------------- Candy physics ------------------------ */
    _updateCandy(sp, dt) {
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
            Object.assign(sp, { dy: 0, dx: 0, g: 0, settled: true });
          }
        }
      }
    },

    /* ---------------- Hit feedback ------------------------- */
    onHit(sp, team) {
      if (sp.type !== 'pinata') return;

      // piñata-specific side effects only
      sp.swingAmp = Math.min(sp.swingAmp + 0.2, 1.3);
      sp.swingFreq = Math.min(sp.swingFreq + 0.7, 5.0);
      if (++this.hits >= HIT_TO_CANDY) this._spawnCandies(sp);
      return true; // keep piñata alive
    },
    /* ---------------- Candy shower ------------------------- */
    _spawnCandies(pinata) {
      const n = Math.floor(between(...CANDY_N_RANGE));
      for (let i = 0; i < n; i++) {
        const ang = between(-CANDY_ANG, CANDY_ANG);
        const dir = pick([-1, 1]);
        const speed = between(...CANDY_SPEED_RANGE);
        this.queueSpawn({
          type: 'candy',
          e: pick(this.cfg.emojis),
          r: between(...CANDY_R_RANGE),
          x: pinata.x,
          y: pinata.y,
          dx: Math.cos(ang) * speed * dir,
          dy: Math.sin(ang) * speed - CANDY_UP,
          g: CANDY_GRAVITY
        });
      }
    }
  }));

})(window);
