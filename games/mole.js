(function(g){
  const { rand, pick } = g.u;
  const TAU = Math.PI * 2;
  const MOLE_LIFETIME_SECS = 10;
  const MOLE_MAX = 3;
  const MOLE_EMOJIS = ['🐭','🐰'];
  const MOLE_ROWS = [3,2,3];
  const SPAWN_DELAY_RANGE = [0, 3];

  function buildGrid(game){
    const rows = MOLE_ROWS;
    const rowCount = rows.length;
    const cellW = game.W / rows[0];
    const cellH = game.H / rowCount;
    const holeSize = Math.min(cellW, cellH) * 0.80;
    const cont = game.container;
    cont.style.setProperty('--hole-size', `${holeSize}px`);
    game.holes = [];
    let idx = 1;
    for(let r=0; r<rowCount; r++){
      const cols = rows[r];
      const ground = (r + 1) * cellH;
      const xOffset = cols < rows[0] ? cellW * 0.5 : 0;
      for(let c=0; c<cols; c++){
        const x = c * cellW + cellW * 0.5 + xOffset;
        const left = x - holeSize/2;
        const top = ground - holeSize/2;
        cont.style.setProperty(`--hole${idx}-x`, `${left}px`);
        cont.style.setProperty(`--hole${idx}-y`, `${top}px`);
        game.holes.push({ x, y: ground, occupied:false });
        idx++;
      }
    }
    for(; idx<=8; idx++){
      cont.style.setProperty(`--hole${idx}-x`, `-100vw`);
      cont.style.setProperty(`--hole${idx}-y`, `-100vh`);
    }
    game.holeR = Math.min(cellW, cellH) * 0.40;
  }

  g.Game.register('mole', g.BaseGame.make({
    max: MOLE_MAX,
    emojis: MOLE_EMOJIS,
    burst: ['💫'],
    spawnDelayRange: SPAWN_DELAY_RANGE,

    onStart(){
      buildGrid(this);
    },


    spawn(){
      const freeHoles = this.holes.filter(h => !h.occupied);
      if (!freeHoles.length) return null;
      const hole = pick(freeHoles);
      const idx = this.holes.indexOf(hole);
      hole.occupied = true;

      const d = {
        x: hole.x,
        y: hole.y - this.holeR,
        dx: 0,
        dy: 0,
        r: this.holeR,
        e: pick(this.emojis),
        ttl: MOLE_LIFETIME_SECS,
        holeIndex: idx,
        p: {
          '--px':     `${hole.x - this.holeR}px`,
          '--py':     `${this.H - hole.y}px`
        }
      };
      return d;
    },


    onHit(sp, team){
      const idx = sp.holeIndex;
      if(idx !== undefined) this.holes[idx].occupied = false;
    },

    onMiss(sp){
      const idx = sp.holeIndex;
      if(idx !== undefined) this.holes[idx].occupied = false;
    }

  }));
})(window);
