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
    max    : COLS * ROWS,
    emojis : FRUITS,

    pending : [],                        /* cells waiting for a fruit */

    onStart () {
      buildGrid(this);
      this.cfg.rRange = [this.cell.r, this.cell.r];

      /* queue initial board fill */
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++)
          this.pending.push({ r, c });
    },

    /* descriptor-only: the engine will turn it into a Sprite */
    spawn () {
      const cell = this.pending.shift();
      if (!cell) return null;
      const { r, c } = cell;
      return {
        x : this.cell.x(c),
        y : this.cell.y(r),
        dx: 0, dy: 0,
        r : this.cell.r,
        e : g.R.pick(this.emojis),
        _row : r, _col : c              /* piggy-back coords */
      };
    },

    /* new engine hook from _onAnimEnd */
    onSpriteAlive (sp) {
      sp.row = sp._row;
      sp.col = sp._col;
      delete sp._row; delete sp._col;
      this.grid[sp.row][sp.col] = sp;
    },

    onHit (sp, team) {
      this._collapseColumn(sp.col, sp.row);
      this._checkMatches(team);
    },

    _collapseColumn (col, fromRow) {
      if (col == null || fromRow == null) return;
      this.grid[fromRow][col] = null;          /* remove popped fruit */

      /* pull everything above down by one row */
      for (let r = fromRow - 1; r >= 0; r--) {
        const mover = this.grid[r][col];
        if (!mover) continue;
        this.grid[r + 1][col] = mover;
        this.grid[r][col]     = null;
        mover.row = r + 1;
        mover.y   = this.cell.y(mover.row);
        mover.draw();
      }

      /* top cell now empty → ask engine for a fresh fruit */
      this.pending.push({ r: 0, c: col });
    },

    _checkMatches (team = 0) {
      const matches = new Set();

      /* horizontal scans */
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

      /* vertical scans */
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

      /* trigger hits */
      if (matches.size) {
        matches.forEach(sp => sp.alive && this.hit(sp, team));
      }
    }
  }));
})(window);
