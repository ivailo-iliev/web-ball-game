(function (g) {
  const EMOJI_SET = [
    '🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉','⭐','🥳','💎',
    '🍀','🌸','🍕','🍔','🍟','🍦','🍩','🍪','🍉','🍓','🍒','🍇','🧸','🎁','🎀','🪁',
    '🪀','🎨','🎧','🎮','🏀','⚾️','🏈','🎯','🚁','✈️','🦄','🐱','🐶','🐸','🐥','🐝','🦋',
    '🌈','🔥','💖','🍭','🍬','🧁','🎂','🍰','🥐','🍌','🍊','🥝','🛼','⛸️','🐰','🐼','🐨',
    '🐧','🐿️','🦊','🐢','🦖','🐯','🐮','🐷','🐹','🐭','💗','💝','😻','💞','🪅','🍿','🥤',
    '🧋','🌞','🌺','🌵','📸','⌚','🧸'
  ];

  const EMOJI_COUNT = 6;
  const R_MIN = 25;
  const R_MAX = 90;
  const V_MIN = 10;
  const V_MAX = 180;
  const SPAWN_SECS = 0.6;
  const WOBBLE_AMPL = 0.10;
  const WOBBLE_FREQ = 0.03;

  g.Game.register('emoji', g.BaseGame.make({
    theme      : 'sky',
    count      : EMOJI_COUNT,
    emojis     : EMOJI_SET,
    spawnEvery : SPAWN_SECS,
    collisions : true,

    spawn() {
      const r = g.R.between(R_MIN, R_MAX);
      const x = g.R.rand(this.W);
      const y = g.R.rand(this.H);
      const speed = g.R.between(V_MIN, V_MAX);
      const ang = g.R.rand(Math.PI * 2);
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed;
      return { x, y, dx: vx, dy: vy, r, e: g.R.pick(this.emojis), hp: 1, wob:g.R.rand(Math.PI*2) };
    },

    move(s, dt) {
      s.wob = (s.wob || 0) + dt * WOBBLE_FREQ;
      s.y += Math.sin(s.wob) * WOBBLE_AMPL;
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      this._wallBounce(s);
    }
  }));
})(window);
