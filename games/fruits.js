(function (g) {
  const COLS = 8, ROWS = 8;
  const FRUITS = ['🍎','🍐','🍊','🍋','🍌','🍇','🍉'];

  function buildGrid(game) {
    const sz = Math.min(game.W / COLS, game.H / ROWS);
    const offX = (game.W - COLS * sz) / 2;
    const offY = (game.H - ROWS * sz) / 2;
    game.cell = {
      size : sz,
      r    : sz * 0.4,
      x    : c => offX + c * sz + sz / 2,
      y    : r => offY + r * sz + sz / 2
    };
    game.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  g.Game.register('fruits', g.BaseGame.make({
    max : 0,
    emojis : FRUITS,

    onStart() {
      buildGrid(this);
      this.cfg.rRange = [this.cell.r, this.cell.r];

      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; r++) {
          const sp = this.addSprite({
            x:this.cell.x(c), y:this.cell.y(r),
            dx:0, dy:0, r:this.cell.r,
            e:g.R.pick(this.emojis)
          });
          sp.col = c;
          sp.row = r;
          this.grid[r][c] = sp;
        }
      }
    },

    spawn() { return null; },

    onHit(sp, team) {
      sp.hitTeam = team;
      this._afterPop(sp, team);
    },

    _afterPop(sp, team = 0) {
      const { col, row } = sp;
      if (col == null || row == null) return;

      this.grid[row][col] = null;

      for (let r = row - 1; r >= 0; r--) {
        const mover = this.grid[r][col];
        if (!mover) continue;
        let dest = r;
        while (dest + 1 < ROWS && this.grid[dest + 1][col] === null) dest++;
        if (dest === r) continue;
        this.grid[dest][col] = mover;
        this.grid[r][col]    = null;
        /*  ✱  Smooth fall handled purely by CSS  ✱
            1.  Give this sprite a one–off transform transition.
            2.  Update its logical position.
            3.  Let the browser tween the transform from the old
                translate3d() to the new one. No timers, no listeners. */
        mover.style.transition = 'transform 0.25s ease-out';
        mover.row = dest;
        mover.y   = this.cell.y(dest);

        /* Trigger one immediate redraw so the first frame of the
           transition starts right now; subsequent draws are still
           driven by the engine’s main loop. */
        mover.draw();
      }

      /* ──────────────────────────────────────────────────────
         1.  How far down does the *new* piece have to travel?
      ────────────────────────────────────────────────────── */
      let target = 0;
      while (target + 1 < ROWS && this.grid[target + 1][col] === null) target++;

      /* ──────────────────────────────────────────────────────
         2.  Create it in ROW-0 *as usual* (keeps the engine’s
             normal  “spawn → animationend → add to pool” flow)
      ────────────────────────────────────────────────────── */
      const fresh = this.addSprite({
        x : this.cell.x(col),
        y : this.cell.y(0),        // visual start at the very top
        dx: 0, dy: 0,
        r : this.cell.r,
        e : g.R.pick(this.emojis)
      });
      fresh.col = col;

      /* book-keep its logical slot right away */
      fresh.row          = target;
      this.grid[target][col] = fresh;

      /* ──────────────────────────────────────────────────────
         3.  Purely cosmetic drop handled in CSS:
             translateY( target × 100% ) using the already
             defined  @keyframes slideDown  animation.
      ────────────────────────────────────────────────────── */
      fresh.style.setProperty('--dist', `${target * 100}%`);
      fresh.el.classList.add('shiftDown');

      this._checkMatches(team);
    },

    _checkMatches(team = 0) {
      const matches = new Set();

      for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; ) {
          const start = this.grid[r][c];
          if (!start) { c++; continue; }
          let end = c + 1;
          while (end < COLS && this.grid[r][end]?.e === start.e) end++;
          if (end - c >= 3) for (let k = c; k < end; k++) matches.add(this.grid[r][k]);
          c = end;
        }
      }

      for (let c = 0; c < COLS; c++) {
        for (let r = 0; r < ROWS; ) {
          const start = this.grid[r][c];
          if (!start) { r++; continue; }
          let end = r + 1;
          while (end < ROWS && this.grid[end][c]?.e === start.e) end++;
          if (end - r >= 3) for (let k = r; k < end; k++) matches.add(this.grid[k][c]);
          r = end;
        }
      }

      if (matches.size) {
        matches.forEach(sp => {
          if (sp.alive) {
            sp.hitTeam = team;
            this.hit(sp, team);
          }
        });
      }
    }
  }));
})(window);
