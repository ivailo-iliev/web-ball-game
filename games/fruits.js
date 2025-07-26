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

    onPointer(x, y, btn = 0) {
      this._showRipple(x, y);
      const team = btn === 2 ? 0 : 1;
      for (const s of this.sprites) {
        if ((x - s.x) ** 2 + (y - s.y) ** 2 <= s.r ** 2) {
          s.hitTeam = team;
          this.hit(s, team);
          break;
        }
      }
    },

    _onAnimEnd(e) {
      const el = e.target;
      const sp = el._sprite;
      if (!sp) return;
      const wasPop = el.classList.contains('pop');
      if (el.classList.contains('spawn')) {
        el.classList.remove('spawn');
        if (this.running && sp.alive !== false) {
          this.sprites.push(sp);
          sp.draw();
        }
      } else if (wasPop) {
        sp.remove();
      }
      if (wasPop) this._afterPop(sp, sp.hitTeam);
    },

    _afterPop(sp, team = 0) {
      const { col, row } = sp;
      if (col == null || row == null) return;

      this.grid[row][col] = null;

      for (let r = row - 1; r >= 0; r--) {
        const mover = this.grid[r][col];
        if (!mover) continue;
        this.grid[r + 1][col] = mover;
        this.grid[r][col]     = null;
        mover.row  = r + 1;
        mover.y    = this.cell.y(r + 1);
        mover.draw();
      }

      const fresh = this.addSprite({
        x:this.cell.x(col), y:this.cell.y(0),
        dx:0, dy:0, r:this.cell.r,
        e:g.R.pick(this.emojis)
      });
      fresh.col = col;
      fresh.row = 0;
      this.grid[0][col] = fresh;

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
