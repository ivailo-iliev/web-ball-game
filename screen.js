(function () {
  'use strict';

  window.currentPage = 0;

  const PAGE_H  = () => $('#container').clientHeight;
  const MAX_IDX = 2;
  let   index   = 0;

  function snapTo(i) {
    index = Math.max(0, Math.min(i, MAX_IDX));
    $('#container').scrollTo({ top: index * PAGE_H(), behavior: 'smooth' });
    window.currentPage = index;          /* 0 launcher | 1 game | 2 config */
    $('#container').dataset.page = index;      /* handy in DevTools */
    Controller.isPreview = (i === 2);
    if (i===1 && Game.current === -1) Game.run(u.pick(Game.list));
  }

  let startY = null;

  $('#container').addEventListener('pointerdown', e => {
    if (!e.isPrimary) return;
    if (window.currentPage === 2 || e.target.closest('#configScreen')) return;
    startY = e.clientY;
    $('#container').setPointerCapture(e.pointerId);   // guarantees pointerup

    /* delegate hit to game engine */
    const team = e.button === 2 ? 0 : 1;
    if (window.Game?.routeHit) Game.routeHit(e.clientX, e.clientY, team);
  }, { passive: true });

  $('#container').addEventListener('pointerup', e => {
    if (startY == null) return;
    if (window.currentPage === 2 || e.target.closest('#configScreen')) { startY = null; return; }
    const dy = e.clientY - startY;
    startY = null;
    if (Math.abs(dy) < 50) return;              // ignore micro swipes
    snapTo(index + (dy > 0 ? -1 : 1));          // down→prev, up→next
  });

  /* Launcher page buttons  (page-0 only) */
  $('#launcher')?.addEventListener('click', e => {
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

  window.Screen = { snapTo };
})();
