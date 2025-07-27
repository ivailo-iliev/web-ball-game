(function (g) {
  const COLS = 8, ROWS = 8;
  const FRUITS = ['🍎','🍐','🍊','🍋','🍌','🍇','🍉'];

  function buildGrid(game) {
    const sz = Math.min(game.W / COLS, game.H / ROWS);
    const offX = (game.W - COLS * sz) / 2;
    const offY = (game.H - ROWS * sz) / 2;

    const xPos = Array.from({ length: COLS }, (_, c) => offX + c * sz + sz / 2);
    const yPos = Array.from({ length: ROWS }, (_, r) => offY + r * sz + sz / 2);

    game.cell = {
      size  : sz,
      r     : sz * 0.4,
      xPos,
      yPos,
      x : c => xPos[c],
      y : r => yPos[r]
    };
    game.grid = Array.from({ length: ROWS }, () => Array(COLS).fill(null));
  }

  g.Game.register('fruits', g.BaseGame.make({
    max    : COLS * ROWS,
    emojis : FRUITS,
    spawnDelayRange : [0, 0],

    pending    : [],                     /* empty grid cells that still need a fruit */
    batchMode  : false,                  /* true while a whole batch is clearing */
    lastTeam   : 0,                      /* attacker that started the current cascade */

    /* pixels-per-second for the falling animation */
    dropSpeed : 600,

    onStart () {
      buildGrid(this);
      this.cfg.rRange = [this.cell.r, this.cell.r];

      /* queue initial board fill */
      for (let r = 0; r < ROWS; r++)
        for (let c = 0; c < COLS; c++) {
          this.pending.push({ r, c });
        }
    },

    /* descriptor-only: the engine will turn it into a Sprite */
    spawn () {
      const cell = this.pending.pop();
      if (!cell) return null;
      const { r, c } = cell;
      const sp = {
        x : this.cell.x(c),
        y : this.cell.y(r),
        dx : 0, dy : 0,
        r  : this.cell.r,
        e  : g.R.pick(this.emojis),
        row : r,
        col : c
      };
      this.grid[r][c] = sp;        /* board knows the fruit immediately */
      return sp;
    },

    onSpriteAlive () {},          /* already registered in spawn() */

    onHit (sp, team) {
      /* remember the team so cascades score correctly */
      this.lastTeam = team;

      /* always remove the sprite from the board */
      if (this.grid[sp.row] && this.grid[sp.row][sp.col] === sp) {
        this.grid[sp.row][sp.col] = null;
      }

      /* During a batch we only pop — collapsing waits until the batch ends */
      if (!this.batchMode) {
        this._collapseColumn(sp.col);
        this._checkMatches(team);
      }
    },

    /* slide every fruit in the column as far down as possible
       and enqueue exactly the right number of new fruits        */
    _collapseColumn (col /*, fromRow is now ignored */) {

      /* 1. compact the column in one pass --------------------- */
      let write = ROWS - 1;                     // lowest slot we can fill

      for (let read = ROWS - 1; read >= 0; read--) {
        const sp = this.grid[read][col];
        if (!sp) continue;                      // hole → skip

        if (read !== write) {                   // needs to fall
          this.grid[write][col] = sp;
          this.grid[read ][col] = null;

          sp.row      = write;
          sp.targetY  = this.cell.y(write);     // where move() must glide to
          sp.falling  = true;
          sp.dy       = this.dropSpeed;         // let the engine animate it
        }
        write--;                                // next free cell above
      }

      /* 2. every cell above “write” is empty → spawn newcomers */
      for (let r = write; r >= 0; r--) {
        /* avoid duplicates with a quick linear check (≤ 64 elements) */
        if (!this.pending.some(p => p.r === r && p.c === col)) {
          this.pending.push({ r, c: col });
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

          /* when the LAST falling fruit lands, resume the cascade loop */
          if (!this.sprites.some(s => s.falling)) {
            this._checkMatches(this.lastTeam || 0);
          }
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

      if (matches.size) {
        /* 1️⃣ POP everything at once */
        this.batchMode = true;
        matches.forEach(sp => sp.alive && this.hit(sp, team));
        this.batchMode = false;

        /* 2️⃣ COLLAPSE each affected column exactly once */
        const cols = new Set();
        matches.forEach(sp => cols.add(sp.col));
        cols.forEach(col => this._collapseColumn(col));

        /* 3️⃣ SCAN again for cascades */
        this._checkMatches(team);
      }
    }
  }));
})(window);
