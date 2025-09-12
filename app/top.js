(function () {
  'use strict';

  const Controller = (() => {
    let running = false;

    async function startDetection() {
      if (running) return;
      running = true;
      const cfg = window.Config?.get?.() || {};
      const TEAM_INDICES = window.TEAM_INDICES || {};

      if (!await Feeds.init()) {
        if ($('#info')) $('#info').textContent = 'Feed init failed';
        running = false;
        return;
      }

      const colorA = TEAM_INDICES[cfg.teamA];
      const colorB = TEAM_INDICES[cfg.teamB];
      const canvas = $('#gfx');
      let infoBase = '';
      let rotationSet = false;

      while (running) {
        const frame = await Feeds.frontFrame();
        if (!frame) { await new Promise(r => setTimeout(r, 0)); continue; }
        try {
          const cropW = frame.displayWidth || frame.codedWidth;
          const cropH = frame.displayHeight || frame.codedHeight;
          if (!rotationSet) {
            canvas.classList.toggle('rotate', cropW > cropH);
            rotationSet = true;
          }
          const rectCfg = cfg.topRect;
          const rect = (rectCfg && rectCfg.w > 0 && rectCfg.h > 0)
            ? rectCfg
            : { x: 0, y: 0, w: cropW, h: cropH };
          const { a, b, w, h, resized } = await GPU.detect({
            key: 'top',
            source: frame,
            colorA,
            colorB,
            domThrA: cfg.domThr[colorA],
            satMinA: cfg.satMin[colorA],
            yMinA: cfg.yMin[colorA],
            yMaxA: cfg.yMax[colorA],
            domThrB: cfg.domThr[colorB],
            satMinB: cfg.satMin[colorB],
            yMinB: cfg.yMin[colorB],
            yMaxB: cfg.yMax[colorB],
            rect: { min: new Float32Array([rect.x, rect.y]), max: new Float32Array([rect.x + rect.w, rect.y + rect.h]) },
            previewCanvas: canvas,
            preview: true,
            activeA: true,
            activeB: true,
            flipY: true,
            radiusPx: cfg.radiusPx,
          });
          if (resized) {
            canvas.width = cropW;
            canvas.height = cropH;
            infoBase = `Running ${w}×${h}, shader.wgsl compute+render (VideoFrame).`;
            if ($('#info')) $('#info').textContent = infoBase;
          }
          const scoreA = (a[0] >>> 16) / 65535;
          const scoreB = (b[0] >>> 16) / 65535;
          const onA = scoreA >= cfg.topMinArea;
          const onB = scoreB >= cfg.topMinArea;
          if (onA || onB) {
            const bit = onA && onB ? '2' : onA ? '0' : '1';
            RTC.send(bit);
          }
        } catch (err) {
          if ($('#info')) $('#info').textContent = (err && err.message) ? err.message : String(err);
          console.error(err);
        } finally {
          frame.close();
        }
      }
    }

    function start() {
      RTC.startA();
    }

    return { start, startDetection };
  })();

  Controller.start();
  // Always expose `isPreview` so configuration overlays remain active.
  window.Controller = { startDetection: Controller.startDetection, isPreview: true };
})();
