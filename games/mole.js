(function(g){
  const MOLE_LIFETIME_SECS = 2;
  const MOLE_MAX = 12;
  const MOLE_EMOJIS = ['🐭','🐰'];
  const MOLE_ROWS = [3,2,3];
  const SPAWN_DELAY_MIN = 0;
  const SPAWN_DELAY_MAX = 3;

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
    spawnDelayMin: SPAWN_DELAY_MIN,
    spawnDelayMax: SPAWN_DELAY_MAX,

    onStart(){
      buildGrid(this);
    },


    spawn(){
      const idx = this.holes.findIndex(h => !h.occupied);
      if(idx === -1) return null;
      const hole = this.holes[idx];
      hole.occupied = true;
      const sp = this.addSprite({
        x: hole.x,
        y: hole.y,
        dx: 0,
        dy: 0,
        r: this.holeR,
        e: g.R.pick(this.emojis),
        hp: 1,
        ttl: MOLE_LIFETIME_SECS
      });
      sp.el.classList.add('mole');
      sp.el.style.setProperty('--mole-h', `${this.holeR*2}px`);
      sp.holeIndex = idx;
    },


    onHit(sp){
      const hole = this.holes[sp.holeIndex];
      if(hole) hole.occupied = false;
    }

  }));
})(window);
