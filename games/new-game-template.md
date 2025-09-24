# Creating a New Mini-Game

This template documents the public engine hooks, helpers, and conventions used by the existing games. Follow these steps to add a new entry under `games/` without modifying the engine.

## 1. File scaffold

Create `games/<your-game>.js` and wrap the code in an IIFE so no new globals are leaked. Destructure utilities you actually use from `g.u` to keep the file concise.

```js
(function (g) {
  'use strict'; // optional, but matches pinata.js and avoids accidental globals

  const { between, pick, rand } = g.u;

  g.Game.register('<your-game-id>', g.BaseGame.make({
    icon: '🎮',
    max: 6,
    rRange: [25, 90],
    vRange: [10, 180],
    spawnDelayRange: [0, 3],
    emojis: ['😀', '😎'],

    onStart() {
      // optional: run once after the engine calls init()
      // e.g. compute grid dimensions or tweak this.cfg values per run
      // this.cfg.rRange = [40, 40];
    },

    spawn() {
      // must return a descriptor with at least x and y
      return {
        x: rand(this.W),
        y: rand(this.H),
        e: pick(this.cfg.emojis)
      };
    },

    move(sprite, dt) {
      // optional: advance sprite state every frame
      sprite.x += sprite.dx * dt;
      sprite.y += sprite.dy * dt;
    },

    onSpriteAlive(sprite) {
      // optional: called when the spawn animation ends
    },

    onHit(sprite, team) {
      // optional: return true to skip the default pop animation
    },

    onMiss(sprite) {
      // optional: respond when a sprite leaves the playfield or expires
    }
  }));
})(window);
```

Use `Object.assign(target, source)` when merging configuration or styles, as seen across the existing games (`pinata.js` copies motion values, `fruits.js` updates falling sprites). The engine already merges your configuration with its defaults—only override what you change.

## 2. Available configuration fields

You can pass the following properties to `BaseGame.make({ ... })`. They merge with the engine defaults, so only override the fields your game needs.

| Field | Type | Purpose |
| --- | --- | --- |
| `icon` | string | Emoji shown on the launcher button. |
| `max` | number | Maximum concurrent sprites. Set to `0` when you fully manage spawning (see `pinata.js`). |
| `rRange` | `[min, max]` | Radius range for spawned sprites. Used if the descriptor omits `r`. |
| `vRange` | `[min, max]` | Speed range used when the descriptor omits `dx`/`dy`. |
| `spawnDelayRange` | `[min, max]` | Seconds between automatic spawns. Return `null` from `spawn()` when nothing should appear (no free holes, etc.). |
| `emojis` | string[] | Default artwork pool if the descriptor omits `e`. |
| `burst` / `burstN` | string[], number | Emoji burst visuals played on hits. |
| `winPoints` | number | Optional score target that ends the match. `Infinity` by default. |
| `gameMinutes` | number | Optional time limit (minutes). Set when running the game. |
| `collisions` | boolean | Enables sprite–sprite collision resolution. |
| `bounceX` / `bounceY` | boolean | Enables wall reflection on the respective axis. |

Avoid redefining engine defaults you do not need—`Object.assign` already merges your overrides with `baseCfg`.

## 3. Sprite descriptors & helpers

`spawn()` must return an object with at least `x` and `y`. You can supply additional fields the engine understands:

- `r`, `dx`, `dy`, `e` – override radius, velocity, and emoji. Omit any of these to let the engine derive them from the configuration (`balloon.js`, `fish.js`).
- `angle`, `scaleX`, `scaleY` – initial transform values; `pinata.js` adjusts `angle` every frame to swing the piñata.
- `ttl` – lifetime in seconds. When it reaches zero the sprite counts as a miss (`mole.js`).
- `type` or other custom fields – safe to add; they stay on the sprite instance and are used heavily by `fruits.js` and `pinata.js` to branch behaviour.
- `s` – plain object of style properties merged via `Object.assign(sprite.style, s)`.
- `p` – plain object of CSS custom properties applied with `style.setProperty` (`gem.js`, `mole.js`).

To create additional sprites in reaction to events (chain reactions, bursts), call `this.queueSpawn(descriptor)` from within your game logic. The engine adds the descriptors on the next animation frame—see `_spawnCandies` in `pinata.js`.

You can also create persistent sprites immediately with `this.addSprite(descriptor)` when you need a long-lived actor (e.g. the swinging piñata). The returned sprite object can be extended—`pinata.js` attaches a custom `draw()` implementation so the rope stays aligned. Remember to keep references on `this` if other hooks need them later.

## 4. Lifecycle hooks & instance state

`BaseGame` calls these hooks if they exist on your game instance:

1. `onStart()` – after `init()`, once per run. Use it to compute derived values (`fruits.js` computes its grid, `mole.js` sizes the board) and to mutate `this.cfg` for per-run tweaks.
2. `spawn()` – whenever the engine needs a new sprite and `this.sprites.length < this.cfg.max`. Return `null` if nothing should spawn (no free holes in `mole.js`).
3. `move(sprite, dt)` – every frame per sprite. Use it to integrate physics (`balloon.js`, `pinata.js`) or resolve cascades (`fruits.js`). Keep it lightweight.
4. `onSpriteAlive(sprite)` – when the spawn animation finishes and the sprite becomes hittable. `fruits.js` uses this to link sprites into its grid.
5. `onHit(sprite, team)` – on pointer hits. Return `true` to prevent the default removal (`gem.js` delays collection until a gem is fully revealed, `pinata.js` keeps the piñata alive).
6. `onMiss(sprite)` – when a sprite leaves the play area or expires; use it to clean up bookkeeping (`mole.js` frees a hole when a mole times out).

You have access to `this.sprites` (all active sprites), `this.cfg` (merged configuration), `this.container` (the DOM element for the playfield), and helpers such as `this.emitBurst(x, y, emojis)` for custom particle effects. Use the `team` parameter supplied to `onHit` to apply team-specific scoring logic; the engine already updates the scoreboard and ripple effect.

## 5. Patterns and best practices from existing games

- **Keep state on the game instance.** Store collections like `this.grid` (fruits) or `this.holes` (mole) during `onStart()` so hooks share data without globals.
- **Use `Object.assign` for targeted updates.** `pinata.js` resets candy motion with `Object.assign(sprite, {...})` and `fruits.js` merges falling sprite properties. Avoid replacing entire objects the engine owns.
- **Prefer engine helpers over manual DOM work.** Use `this.emitBurst`, `this.queueSpawn`, and `this.addSprite` for new actors. When DOM nodes are needed, attach them to `this.container` and cache references on the game instance (`gem.js` stores collection columns, `pinata.js` caches the piñata sprite).
- **Respect engine responsibilities.** Let the engine handle score increments, sprite removal, ripple effects, and lifecycle transitions. Games never override `init`, `loop`, `hit`, `miss`, or `end`.
- **Keep per-frame logic minimal.** Cache expensive calculations, reuse `Math` helpers, and exit early when work is unnecessary (`fruits.js` skips checks when no matches are pending).
- **Clamp spawning to available space.** Check capacity before spawning and return `null` when the board is full (`mole.js`, `fruits.js`). The engine will wait and retry.
- **Tune with constants.** Define configuration objects or `Object.freeze`d maps at the top of the file to document gameplay knobs (`pinata.js`). Reuse pure helper functions for clarity (`fruits.js` splits logic into `_collapseColumn` and `_checkMatches`).
- **Keep CSS modular.** When a game needs specific styling, add it to `styles/<game>.css` and toggle via class names or CSS variables set on `this.container` (`mole.js` writes `--holeN` values, `gem.js` animates reveals with `--mr`).
- **Clean up mirrored state.** If you mark external data when spawning, clear it in both `onHit` and `onMiss` so resources become available again (`mole.js` frees hole occupancy in both hooks).
- **Stay within the documented interfaces.** Do not add new hooks, mutate engine prototypes, or import other modules. Use only `g.Game`, `g.BaseGame`, `g.Sprite`, and `g.u` APIs.

## 6. Restrictions

- **Do not modify** `game-engine.js`, `app/utils.js`, or any other engine files.
- **Do not override** engine methods other than the documented hooks. Leave `init`, `loop`, `hit`, `miss`, and `end` untouched.
- **Do not introduce new globals or interfaces.** Keep everything inside the module scope returned by the IIFE.
- **Do not duplicate engine responsibilities.** Scoring UI, burst animations, sprite removal, ripple effects, and timing are already handled by the engine.
- **Do not bypass existing helpers.** Stick to provided utilities (`g.u`, `this.emitBurst`, etc.) instead of reimplementing them.

By following this template—and studying the patterns above—you can create new games that plug cleanly into the shared engine while preserving compatibility with the existing launcher and scoring logic.
