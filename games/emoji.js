(function (g) {
  const EMOJI_SET = [
    '🕶️','🤖','🥨','🦥','🌻','🪙','🥇','🏆','🎒','','','','🎉','⭐','🥳','💎',
    '🍀','🌸','🍕','🍔','🍟','🍦','🍩','🍪','🍉','🍓','🍒','🍇','🧸','🎁','🎀','🪁',
    '🪀','🎨','🎧','🎮','🏀','⚾️','🏈','🎯','🚁','✈️','🦄','🐱','🐶','🐸','🐥','🐝','🦋',
    '🌈','🔥','💖','🍭','🍬','🧁','🎂','🍰','🥐','🍌','🍊','🥝','🛼','⛸️','🐰','🐼','🐨',
    '🐧','🐿️','🦊','🐢','🦖','🐯','🐮','🐷','🐹','🐭','💗','💝','😻','💞','🪅','🍿','🥤',
    '🧋','🌞','🌺','🌵','📸','⌚','🧸'
  ];

  const EMOJI_MAX = 6;
  const R_RANGE = [25, 90];
  const V_RANGE = [10, 180];
  const SPAWN_DELAY_RANGE = [0, 3];
  const ROT_AMPL = 0.10;
  const ROT_FREQ = 0.03;

  g.Game.register('emoji', g.BaseGame.make({
    max        : EMOJI_MAX,
    emojis     : EMOJI_SET,
    spawnDelayRange : SPAWN_DELAY_RANGE,
    collisions : true,
    bounceX    : true,
    bounceY    : true,

    spawn() {
      const r = g.R.between(...R_RANGE);
      const x = g.R.rand(this.W);
      const y = g.R.rand(this.H);
      const speed = g.R.between(...V_RANGE);
      const ang = g.R.rand(Math.PI * 2);
      const vx = Math.cos(ang) * speed;
      const vy = Math.sin(ang) * speed;
      const d = {
        x,
        y,
        dx: vx,
        dy: vy,
        r,
        e: g.R.pick(this.emojis)
      };
      return d;
    },

    move(s, dt) {
      s.x += s.dx * dt;
      s.y += s.dy * dt;
      s.angle = Math.sin((s.x + s.y) * ROT_FREQ) * ROT_AMPL;
    }
  }));
})(window);
