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

    pending : [],                        /* empty grid cells that still need a fruit */

    /* pixels-per-second for the falling animation */
    dropSpeed : 600,

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
        dx: 0, dy: 0,                 /* will stay 0 until a collapse */
        r : this.cell.r,
        e : g.R.pick(this.emojis),
        _row : r, _col : c              /* piggy-back coords */
      };
    },

    /* new engine hook from _onAnimEnd */
    onSpriteAlive (sp) {
      alert(`alive ${sp.e} at ${sp.row},${sp.col}`);
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
      alert(`collapse column=${col} fromRow=${fromRow}`);
      if (col == null || fromRow == null) return;
      this.grid[fromRow][col] = null;          /* remove the popped fruit */

      /* mark every fruit above as “falling” and let move() animate it */
      for (let r = fromRow - 1; r >= 0; r--) {
        const sp = this.grid[r][col];
        if (!sp) continue;
        alert(`falling ${sp.e} to row ${sp.row}`);
        this.grid[r + 1][col] = sp;
        this.grid[r][col]     = null;
        sp.row = r + 1;
        sp.targetY = this.cell.y(sp.row);   /* where it must stop */
        sp.falling = true;
        sp.dy = this.dropSpeed;             /* engine’s move() will use this */
      }

      /* top cell now empty → ask engine for a fresh fruit */
      this.pending.push({ r: 0, c: col });
    },

    /* make falling fruits glide until they reach .targetY */
    move (sp, dt) {
      alert(`move ${sp.e} y=${sp.y.toFixed(1)} dy=${sp.dy}`);
      if (sp.falling) {
        sp.y += sp.dy * dt;
        if (sp.y >= sp.targetY) {
          sp.y = sp.targetY;
          sp.dy = 0;
          sp.falling = false;
          delete sp.targetY;
        }
      }
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
