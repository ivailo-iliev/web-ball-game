/*───────────────────────────────────────────────────────────
    Globals
───────────────────────────────────────────────────────────*/
const domCache = {};
window.$ = sel => domCache[sel] || (domCache[sel] = document.querySelector(sel));

window.u = Object.freeze({
  rand   : n      => Math.random() * n,
  pick   : arr    => arr[Math.floor(Math.random() * arr.length)],
  between: (a, b) => a + Math.random() * (b - a),
  clamp  : (n,l,h)=> n < l ? l : n > h ? h : n
});

const container = $('#container');

/* current page index for ultra-fast hit routing */
window.currentPage = 0;

/*───────────────────────────────────────────────────────────
    Three-page vertical pager  (0-launcher | 1-game | 2-config)
───────────────────────────────────────────────────────────*/
const PAGE_H  = () => container.clientHeight;
const MAX_IDX = 2;
let   index   = 0;

function snapTo(i) {
  index = Math.max(0, Math.min(i, MAX_IDX));
  container.scrollTo({ top: index * PAGE_H(), behavior: 'smooth' });
  window.currentPage = index;          /* 0 launcher | 1 game | 2 config */
  container.dataset.page = index;      /* handy in DevTools */
  if (i===2) App.Controller.setPreview(true);
  else App.Controller.setPreview(false); 
}

/* global vertical swipe */
let startY = null;

container.addEventListener('pointerdown', e => {
  if (!e.isPrimary) return;
  if (window.currentPage === 2 || e.target.closest('#configScreen')) return;
  startY = e.clientY;
  container.setPointerCapture(e.pointerId);   // guarantees pointerup

  /* delegate hit to game engine */
  const team = e.button === 2 ? 0 : 1;
  if (window.Game?.routeHit) Game.routeHit(e.clientX, e.clientY, team);
}, { passive: true });

container.addEventListener('pointerup', e => {
  if (startY == null) return;
  if (window.currentPage === 2 || e.target.closest('#configScreen')) { startY = null; return; }
  const dy = e.clientY - startY;
  startY = null;
  if (Math.abs(dy) < 50) return;              // ignore micro swipes
  snapTo(index + (dy > 0 ? -1 : 1));          // down→prev, up→next
});

/*───────────────────────────────────────────────────────────
    Launcher page buttons  (page-0 only)
───────────────────────────────────────────────────────────*/
const launcher = $('#launcher');

if (launcher) {
  launcher.addEventListener('click', e => {
    const btn = e.target.closest('button');
    if (!btn) return;
    const game = btn.dataset.game;
    if (game) {
      Game.run(game);
      snapTo(1); // jump to game page
    } else if (btn.dataset.config !== undefined) {
      snapTo(2); // jump to config page
    }
  });
}

// Enhance number inputs with spinner buttons
function initNumberSpinners() {
    document.querySelectorAll('input[type=number]:not([data-spinner])').forEach(input => {
        input.setAttribute('data-spinner', '');

        // wrap + buttons
        const wrap = document.createElement('span');
        wrap.className = 'num-spinner';
        input.before(wrap);
        wrap.append(
            input,
            Object.assign(document.createElement('button'), {
                type: 'button',
                className: 'down',
                textContent: '−',
                onclick() {
                    input.stepDown();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    update();
                }
            }),
            Object.assign(document.createElement('button'), {
                type: 'button',
                className: 'up',
                textContent: '+',
                onclick() {
                    input.stepUp();
                    input.dispatchEvent(new Event('input', { bubbles: true }));
                    update();
                }
            })
        );

        // disable at bounds
        const update = () => {
            const val = parseFloat(input.value);
            const min = parseFloat(input.min);
            const max = parseFloat(input.max);
            wrap.querySelector('.down').disabled = !isNaN(min) && val <= min;
            wrap.querySelector('.up').disabled = !isNaN(max) && val >= max;
        };
        input.addEventListener('input', update);
        update();
    });
}

window.initNumberSpinners = initNumberSpinners;

