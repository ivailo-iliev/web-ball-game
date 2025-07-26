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
            x : this.cell.x(c),
            y : this.cell.y(r),
            dx: 0, dy: 0,
            r : this.cell.r,
            e : g.R.pick(this.emojis)
          });
          sp.col = c;
          sp.row = r;
          this.grid[r][c] = sp;

          /* ⬇  No “fruitSpawn” scale-in — activate immediately */
          sp.el.classList.remove('spawn');
          this.sprites.push(sp);
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
        mover.row = dest;
        mover.y   = this.cell.y(dest);
        mover.draw();              /* engine will keep it updated */
      }

      /* ---- straight-in spawn, no extra CSS effects ---- */
      let target = 0;
      while (target + 1 < ROWS && this.grid[target + 1][col] === null) target++;

      const fresh = this.addSprite({
        x : this.cell.x(col),
        y : this.cell.y(target),
        dx: 0, dy: 0,
        r : this.cell.r,
        e : g.R.pick(this.emojis)
      });
      fresh.col = col;
      fresh.row = target;
      this.grid[target][col] = fresh;

      fresh.el.classList.remove('spawn');   /* no “fruitSpawn” */
      this.sprites.push(fresh);             /* active right away */

      fresh.draw();

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
