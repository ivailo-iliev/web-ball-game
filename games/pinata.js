(function(g){
  /* ────────────────────────────────────────────────────────────
     PIÑATA - PARTY  🎉🍬
     ──────────────────────────────────────────────────────────── */
  const PinataGame = g.BaseGame.make({

    /* 0. engine cfg tweaks – disable auto-spawns, allow plenty of sprites */
    max            : 999,                   // we’ll manage spawns by hand
    spawnDelayRange: [999, 999],            // engine never calls spawn()
    collisions     : false,

    emojis         : ['🍬','🍭','🍡','🍫','🍪','🧁'],  // candy artwork

    /* 1.  game-start : build the piñata sprite */
    onStart() {
      /* remember basics for decay maths */
      this._baseAmp   = 0.20;               // rad
      this._baseFreq  = 2.0;                // rad · s⁻¹
      this._decayAmp  = 0.10;               // rad · s⁻¹
      this._decayFreq = 0.50;               // rad · s⁻²
      this._hits      = 0;

      /* make one “swaying” sprite */
      const pinata = this.addSprite({
        x : this.W * 0.5,
        y : this.H * 0.30,
        r : 70,
        e : '🪅',

        /* pendulum bookkeeping */
        type        : 'pinata',
        baseX       : this.W * 0.5,
        baseY       : this.H * 0.30,
        swingR      : 140,                  // horizontal swing radius (px)
        swingAmp    : this._baseAmp,
        swingFreq   : this._baseFreq,
        swingT      : 0
      });
      /* note: addSprite() leaves it in “spawn” state; it’ll be pushed into
         this.sprites automatically by the engine’s _onAnimEnd hook. */
    },

    /* 2.  player clicks */
    onPointer(x, y, btn = 0) {
      this._showRipple(x, y);
      for (const s of this.sprites) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 > s.r ** 2) continue;

        const team = btn === 2 ? 0 : 1;     // mirror engine convention

        if (s.type === 'pinata') {
          /* ---- PIÑATA HIT ---- */
          this._hits++;

          /* award normal points, but keep piñata alive */
          const pts = this.calculatePoints(s);
          this.score[team] += pts;
          scoreEl[team].textContent = `${this.score[team]}`;
          this.emitBurst(s.x, s.y, ['✨','💥','💫']);

          /* pump up swing ↓ */
          s.swingAmp  = Math.min(s.swingAmp + 0.20, 1.30);
          s.swingFreq = Math.min(s.swingFreq + 0.70, 5.00);

          /* from the 5th hit onward rain candy */
          if (this._hits >= 5) this._spawnCandies(s);
        } else {
          /* ---- CANDY HIT (use regular engine logic) ---- */
          g.BaseGame.prototype.hit.call(this, s, team);
        }
        break;                              // only the first intersecting sprite
      }
    },

    /* 3.  frame-by-frame motion */
    move(s, dt) {
      if (s.type === 'pinata') {
        s.swingT += dt;

        /* ease swing amp & speed back to base */
        if (s.swingAmp  > this._baseAmp)  s.swingAmp  = Math.max(this._baseAmp,  s.swingAmp  - this._decayAmp  * dt);
        if (s.swingFreq > this._baseFreq) s.swingFreq = Math.max(this._baseFreq, s.swingFreq - this._decayFreq * dt);

        const ϕ = s.swingAmp * Math.sin(s.swingFreq * s.swingT);

        s.angle = ϕ;
        s.x     = s.baseX + Math.sin(ϕ) * s.swingR;
        s.y     = s.baseY + Math.abs(Math.sin(ϕ)) * (s.swingR * 0.10); // small vertical bob
      }
      else if (s.type === 'candy') {
        s.dy += s.g * dt;                   // gravity
        s.x  += s.dx * dt;
        s.y  += s.dy * dt;
      }
    },

    /* 4. helper – burst of candies */
    _spawnCandies(p) {
      const N   = 5 + Math.floor(R.rand(5));   // 5-9 candies
      const g   = 900;                         // px · s⁻²
      for (let i = 0; i < N; i++) {
        const ang   = R.between(-Math.PI / 3, Math.PI / 3); // fan outward
        const speed = R.between(200, 350);
        const dx    = Math.cos(ang) * speed;
        const dy    = Math.sin(ang) * speed - 200;          // upward kick

        this.addSprite({
          x   : p.x,
          y   : p.y,
          r   : R.between(20, 32),
          e   : R.pick(this.cfg.emojis),
          dx, dy,
          g,                          // custom gravity flag
          type: 'candy'
        });
      }
    }
  });

  /* 5.  register with the engine */
  g.Game.register('pinata', PinataGame);
})(window);
