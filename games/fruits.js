(function (g) {
  const COLS = 10, ROWS = 5;
  const indexToRow = i => Math.floor(i / COLS);
  const indexToCol = i => i % COLS;
  const FRUITS = ['🫐','🍐','🍊','🥥','🍌','🍇','🍉'];

  function buildGrid(game) {
    const sz = Math.min(game.W / COLS, game.H / ROWS);
    const offX = (game.W - COLS * sz) / 2;
    const offY = (game.H - ROWS * sz) / 2;
    game.cell = {
      size : sz,
      r    : sz * 0.4,
      x    : col => offX + col * sz + sz / 2,
      y    : row => offY + row * sz + sz / 2
    };
    game.grid = Array(COLS * ROWS).fill(null);
  }

  g.Game.register('fruits', g.BaseGame.make({
    max    : COLS * ROWS,
    emojis : FRUITS,
    spawnDelayRange : [0, 0],

    pending : [],                        /* empty grid cells that still need a fruit */
    batchMode : false,                   /* ← NEW: “clear-everything-first” flag */

    /* pixels-per-second for the falling animation */
    dropSpeed : 600,

    onStart () {
      buildGrid(this);
      this.cfg.rRange = [this.cell.r, this.cell.r];

      /* queue initial board fill */
      for (let i = 0; i < COLS * ROWS; i++)
        this.pending.push(i);
    },

    /* descriptor-only: the engine will turn it into a Sprite */
    spawn () {
      const idx = this.pending.shift();
      if (idx === undefined) return null;
      const row = indexToRow(idx);
      const col = indexToCol(idx);
      return {
        x : this.cell.x(col),
        y : this.cell.y(row),
        dx : 0, dy : 0,
        r  : this.cell.r,
        e  : g.R.pick(this.emojis),
        holeIndex : idx                 /* kept by addSprite → Sprite */
      };
    },

    /* new engine hook from _onAnimEnd */
    onSpriteAlive (sp) {
      this.grid[sp.holeIndex] = sp;
    },

    onHit (sp, team) {
      /* remember the team so cascades score correctly */
      this.lastTeam = team;

      /* always remove the sprite from the board */
      if (this.grid[sp.holeIndex] === sp) {
        this.grid[sp.holeIndex] = null;
      }

      /* During a batch we only pop — collapsing waits until the batch ends */
      if (!this.batchMode) {
        this._collapseColumn(indexToCol(sp.holeIndex));
        this._checkMatches(team);
      }
    },

    /* slide every fruit in the column as far down as possible
       and enqueue exactly the right number of new fruits        */
    _collapseColumn (col /*, fromRow is now ignored */) {

      /* 1. compact the column in one pass --------------------- */
      let write = ROWS - 1;                     // lowest slot we can fill

      for (let read = ROWS - 1; read >= 0; read--) {
        const readIdx = read * COLS + col;
        const sp = this.grid[readIdx];
        if (!sp) continue;                      // hole → skip

        if (read !== write) {                   // needs to fall
          const writeIdx = write * COLS + col;
          this.grid[writeIdx] = sp;
          this.grid[readIdx]  = null;

          sp.holeIndex = writeIdx;
          sp.targetY  = this.cell.y(write);     // where move() must glide to
          sp.falling  = true;
          sp.dy       = this.dropSpeed;         // let the engine animate it
        }
        write--;                                // next free cell above
      }

      /* 2. every cell above “write” is empty → spawn newcomers */
      for (let row = write; row >= 0; row--) {
        const idx = row * COLS + col;
        /* avoid duplicates when this function is called again in the same frame */
        if (!this.pending.includes(idx)) {
          this.pending.push(idx);
        }
      }
    },

    /* make falling fruits glide until they reach .targetY */
    move (sp, dt) {
      if (sp.falling) {
        sp.y += sp.dy * dt;
        if (sp.y >= sp.targetY) {
          sp.y = sp.targetY;
          sp.dy = 0;
          sp.falling = false;
          delete sp.targetY;

          /* when the LAST fruit settles, check for cascades */
          if (!this.sprites.some(s => s.falling)) {
            this._checkMatches(this.lastTeam || 0);
          }
        }
      }
    },

    _checkMatches (team = 0) {
      const matches = new Set();

      /* horizontal scans */
      for (let row = 0; row < ROWS; row++) {
        for (let col = 0; col < COLS; ) {
          const start = this.grid[row * COLS + col];
          if (!start) { col++; continue; }
          let end = col + 1;
          while (end < COLS && this.grid[row * COLS + end]?.e === start.e) end++;
          if (end - col >= 3) {
            for (let k = col; k < end; k++) matches.add(this.grid[row * COLS + k]);
          }
          col = end;
        }
      }

      /* vertical scans */
      for (let col = 0; col < COLS; col++) {
        for (let row = 0; row < ROWS; ) {
          const start = this.grid[row * COLS + col];
          if (!start) { row++; continue; }
          let end = row + 1;
          while (end < ROWS && this.grid[end * COLS + col]?.e === start.e) end++;
          if (end - row >= 3) {
            for (let k = row; k < end; k++) matches.add(this.grid[k * COLS + col]);
          }
          row = end;
        }
      }

      /* resolve the batch in three phases */
      if (matches.size) {
        /* ── 1. pop everything at once ─────────────────────── */
        this.batchMode = true;
        matches.forEach(sp => sp.alive && this.hit(sp, team));
        this.batchMode = false;

        /* ── 2. collapse each affected column exactly once ─── */
        const cols = new Set();
        matches.forEach(sp => cols.add(indexToCol(sp.holeIndex)));
        cols.forEach(col => this._collapseColumn(col));

        /* ── 3. look for chain reactions after the board settled ── */
        this._checkMatches(team);
      }
    }
  }));
})(window);
