(function () {
  'use strict';

  const App = window.App || {};
  let Config = App.Config;
  const PreviewGfx = App.PreviewGfx;
  const Controller = App.Controller;
  const TOP_MODE_MJPEG = 'mjpeg';
  const TOP_MODE_WEBRTC = 'webrtc';
  const TEAM_INDICES = { red: 0, green: 1, blue: 2, yellow: 3 };
  const COLOR_EMOJI = {
    red: '🔴',
    green: '🟢',
    blue: '🔵',
    yellow: '🟡'
  };
  const CAM_W = 1920;
  const CAM_H = 886;
  const ASPECT = CAM_H / CAM_W;
  const DOM_THR_DEFAULT = 0.10;
  const SATMIN_DEFAULT  = 0.12;
  const YMIN_DEFAULT    = 0.00;
  const YMAX_DEFAULT    = 0.70;
  const RADIUS_DEFAULT  = 18;

  const Setup = (() => {
    let cfg;

    function initNumberSpinners() {
      document.querySelectorAll('input[type=number]:not([data-spinner])').forEach(input => {
        input.setAttribute('data-spinner', '');

        const wrap = document.createElement('span');
        wrap.className = 'num-spinner';
        input.before(wrap);

        const btnDown = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'down',
          textContent: '−',
          onclick() {
            input.stepDown();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }
        });
        const btnUp = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'up',
          textContent: '+',
          onclick() {
            input.stepUp();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }
        });

        wrap.append(input, btnDown, btnUp);

        const min = parseFloat(input.min);
        const max = parseFloat(input.max);

        const update = () => {
          const val = parseFloat(input.value);
          btnDown.disabled = !isNaN(min) && val <= min;
          btnUp.disabled = !isNaN(max) && val >= max;
        };
        input.addEventListener('input', update);
        update();
      });
    }

    function bind() {
      if (!Config) {
        const { createConfig } = window;
        const DEFAULT_CROP_W = 1280;
        const DEFAULT_CROP_H = Math.round(DEFAULT_CROP_W * ASPECT) & ~1;
        const DEFAULT_ZOOM = CAM_W / DEFAULT_CROP_W;
        const defaults = {
          topZoom: DEFAULT_ZOOM,
          topResW: DEFAULT_CROP_W,
          topResH: DEFAULT_CROP_H,
          topMinArea: 0.025,
          teamA: 'green',
          teamB: 'blue',
          domThr: Array(4).fill(DOM_THR_DEFAULT),
          satMin: Array(4).fill(SATMIN_DEFAULT),
          yMin: Array(4).fill(YMIN_DEFAULT),
          yMax: Array(4).fill(YMAX_DEFAULT),
          radiusPx: RADIUS_DEFAULT
        };
        Config = createConfig(defaults);
        Config.load();
        cfg = Config.get();
        cfg.domThr = Float32Array.from(cfg.domThr);
        cfg.satMin = Float32Array.from(cfg.satMin);
        cfg.yMin = Float32Array.from(cfg.yMin);
        cfg.yMax = Float32Array.from(cfg.yMax);
      } else {
        cfg = Config.get();
      }
      const urlI = $('#topUrl');
      const urlWarn = $('#urlWarn');
      const selMode = $('#topMode');
      const frontZoomEl = $('#frontZoom');
      const zoomInput = $('#zoom');
      const minAreaInput = $('#topMinInp');
      const topTex = $('#topTex');
      const topOv = $('#topOv');
      const frontTex = $('#frontTex');
      const frontOv = $('#frontOv');
      const topHInp = $('#topHInp');
      const frontHInp = $('#frontHInp');
      if (topTex) { topTex.width = cfg.topResW; topTex.height = cfg.topResH; }
      if (topOv) { topOv.width = cfg.topResW; topOv.height = cfg.topResH; }
      if (frontTex) { frontTex.width = cfg.frontResW; frontTex.height = cfg.frontResH; }
      if (frontOv) { frontOv.width = cfg.frontResW; frontOv.height = cfg.frontResH; }
      if (topHInp) topHInp.max = cfg.topResH;
      if (frontHInp) frontHInp.max = cfg.frontResH;
      frontZoomEl?.setAttribute('data-spinner', '');
      if (frontZoomEl) frontZoomEl.value = cfg.frontZoom;
      function onFrontZoomInput(e) {
        cfg.frontZoom = Math.max(1, +e.target.value);
        cfg.frontResW = Math.round(CAM_W / cfg.frontZoom) & ~1;
        cfg.frontResH = Math.round(cfg.frontResW * ASPECT) & ~1;
        Config.save('frontZoom', cfg.frontZoom);
        Config.save('frontResW', cfg.frontResW);
        Config.save('frontResH', cfg.frontResH);
        if (frontTex) { frontTex.width = cfg.frontResW; frontTex.height = cfg.frontResH; }
        if (frontOv) { frontOv.width = cfg.frontResW; frontOv.height = cfg.frontResH; }
      }
      frontZoomEl?.addEventListener('input', onFrontZoomInput);
      if (zoomInput) {
        zoomInput.value = cfg.topZoom;
        zoomInput.addEventListener('input', e => {
          cfg.topZoom = Math.max(1, +e.target.value);
          cfg.topResW = Math.round(CAM_W / cfg.topZoom) & ~1;
          cfg.topResH = Math.round(cfg.topResW * ASPECT) & ~1;
          Config.save('topZoom', cfg.topZoom);
          Config.save('topResW', cfg.topResW);
          Config.save('topResH', cfg.topResH);
        });
      }
      if (minAreaInput) {
        minAreaInput.value = cfg.topMinArea;
        minAreaInput.addEventListener('input', e => {
          cfg.topMinArea = Math.max(0, Math.min(1, +e.target.value));
          Config.save('topMinArea', cfg.topMinArea);
        });
      }
      const selA = $('#teamA');
        const selB = $('#teamB');
        const domAInput = $('#domA');
        const domBInput = $('#domB');
        const satMinAInput = $('#satMinA');
        const satMinBInput = $('#satMinB');
        const yMinAInput = $('#yMinA');
        const yMinBInput = $('#yMinB');
        const yMaxAInput = $('#yMaxA');
        const yMaxBInput = $('#yMaxB');
        const radiusInput = $('#radiusPx');

        let teamA = cfg.teamA;
        let teamB = cfg.teamB;
        let domThrA = cfg.domThr[TEAM_INDICES[teamA]];
        let domThrB = cfg.domThr[TEAM_INDICES[teamB]];
        let satMinA = cfg.satMin[TEAM_INDICES[teamA]];
        let satMinB = cfg.satMin[TEAM_INDICES[teamB]];
        let yMinA = cfg.yMin[TEAM_INDICES[teamA]];
        let yMinB = cfg.yMin[TEAM_INDICES[teamB]];
        let yMaxA = cfg.yMax[TEAM_INDICES[teamA]];
        let yMaxB = cfg.yMax[TEAM_INDICES[teamB]];

        domAInput.value = domThrA;
        domBInput.value = domThrB;
        satMinAInput.value = satMinA;
        satMinBInput.value = satMinB;
        yMinAInput.value = yMinA;
        yMinBInput.value = yMinB;
        yMaxAInput.value = yMaxA;
        yMaxBInput.value = yMaxB;
        radiusInput.value = cfg.radiusPx;

        domAInput?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamA]] = domThrA = +e.target.value;
          Config.save('domThr', Array.from(cfg.domThr));
        });
        domBInput?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamB]] = domThrB = +e.target.value;
          Config.save('domThr', Array.from(cfg.domThr));
        });
        satMinAInput?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamA]] = satMinA = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin));
        });
        satMinBInput?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamB]] = satMinB = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin));
        });
        yMinAInput?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamA]] = yMinA = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin));
        });
        yMinBInput?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamB]] = yMinB = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin));
        });
        yMaxAInput?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamA]] = yMaxA = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax));
        });
        yMaxBInput?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamB]] = yMaxB = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax));
        });
        radiusInput?.addEventListener('input', e => {
          cfg.radiusPx = Math.max(0, +e.target.value);
          Config.save('radiusPx', cfg.radiusPx);
        });

        if (selMode) selMode.value = cfg.topMode;
        selMode?.addEventListener('change', e => {
          cfg.topMode = e.target.value;
          Config.save('topMode', cfg.topMode);
        });

        initNumberSpinners();
      const btnStart = $('#btnStart');
      const btnTop   = $('#btnTop');
      const btnFront = $('#btnFront');
      const btnBoth  = $('#btnBoth');

      const cfgScreen = $('#configScreen');
      btnStart?.addEventListener('click', () => snapTo(1));
      btnTop?.addEventListener('click', () => cfgScreen.className = 'onlyTop');
      btnFront?.addEventListener('click', () => cfgScreen.className = 'onlyFront');
      btnBoth?.addEventListener('click', () => cfgScreen.className = '');

      const startDemo = $('#start');
      const info = $('#info');
      const canvas = $('#gfx');
      let infoBase = '';
      let lastFrameTS;

      startDemo?.addEventListener('click', async function onStartClick() {
        startDemo.disabled = true;
        infoBase = '';
        try {
          if (!await Feeds.init()) {
            if (info) info.textContent = 'Feed init failed';
            startDemo.disabled = false;
            return;
          }
          let busy = false;
          async function loop() {
            const frame = await Feeds.frontFrame();
            if (!frame) { requestAnimationFrame(loop); return; }
            if (busy) { frame.close(); requestAnimationFrame(loop); return; }
            const now = performance.now();
            if (lastFrameTS !== undefined && info) {
              const fps = 1000 / (now - lastFrameTS);
              info.textContent = `${infoBase} ${fps.toFixed(1)} fps`;
            }
            lastFrameTS = now;
            busy = true;
            try {
              const cropW = frame.displayWidth || frame.codedWidth;
              const cropH = frame.displayHeight || frame.codedHeight;
              const colorA = TEAM_INDICES[cfg.teamA];
              const colorB = TEAM_INDICES[cfg.teamB];
              const { a, b, w, h, resized } = await GPUShared.detect({
                key: 'demo',
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
                rect: { min: new Float32Array([0, 0]), max: new Float32Array([cropW, cropH]) },
                previewCanvas: canvas,
                preview: true,
                activeA: true, activeB: true,
                flipY: true,
                radiusPx: cfg.radiusPx,
              });
              if (resized && canvas) {
                canvas.width = frame.displayWidth;
                canvas.height = frame.displayHeight;
                infoBase = `Running ${w}×${h}, shader.wgsl compute+render (VideoFrame).`;
                if (info) info.textContent = infoBase;
              }
              const scoreA = (a[0] >>> 16) / 65535;
              const scoreB = (b[0] >>> 16) / 65535;
              const onA = scoreA >= cfg.topMinArea;
              const onB = scoreB >= cfg.topMinArea;
              if (onA || onB) {
                const bit = onA && onB ? '2' : onA ? '0' : '1';
                if (window.sendBit) window.sendBit(bit);
              }
            } finally {
              frame.close();
              busy = false;
            }
            requestAnimationFrame(loop);
          }
          requestAnimationFrame(loop);
        } catch (err) {
          if (info) info.textContent = (err && err.message) ? err.message : String(err);
          startDemo.disabled = false;
          console.error(err);
        }
      });

    const topROI = { y: 0, h: cfg.topH };

    function drawPolyTop() { PreviewGfx.drawROI(cfg.polyT, 'lime', 'top'); }
    function drawPolyFront() { PreviewGfx.drawROI(cfg.polyF, 'aqua', 'front'); }

    function commitTop() {
      topROI.y = Math.min(Math.max(0, topROI.y), cfg.topResH - topROI.h);
      const { y, h } = topROI;
      cfg.polyT = [[0, y], [cfg.topResW, y], [cfg.topResW, y + h], [0, y + h]];
      Config.save('polyT', cfg.polyT);
      drawPolyTop();
    }

      if (cfg.polyT.length === 4) {
        const ys = cfg.polyT.map(p => p[1]);
        topROI.y = Math.min(...ys);
        topROI.h = Math.max(...ys) - topROI.y;
      }

      if (topOv) {
        /* vertical drag on overlay */
        let dragY = null;
        topOv.style.touchAction = 'none';
        topOv.addEventListener('pointerdown', e => {
          if (!Controller.isPreview()) return;
          const r = topOv.getBoundingClientRect();
          dragY = (e.clientY - r.top) * cfg.topResH / r.height;
          topOv.setPointerCapture(e.pointerId);
        });
        topOv.addEventListener('pointermove', e => {
          if (dragY == null || !Controller.isPreview()) return;
          const r = topOv.getBoundingClientRect();
          const curY = (e.clientY - r.top) * cfg.topResH / r.height;
          topROI.y += curY - dragY;
          dragY = curY;
          commitTop();
        });
        topOv.addEventListener('pointerup', () => dragY = null);
        topOv.addEventListener('pointercancel', () => dragY = null);
      }

      commitTop();

      (function () {
        // Front ROI: fixed aspect, height-driven; gesture = drag only
        const ASPECT = cfg.frontResW / cfg.frontResH;
        let roi = { x: 0, y: 0, w: cfg.frontH * ASPECT, h: cfg.frontH };
        if (cfg.polyF?.length === 4) {
          const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs);
          const y0 = Math.min(...ys), y1 = Math.max(...ys);
          roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          // re-lock width to height*aspect in case stored poly drifted
          roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
          roi.w = roi.h * ASPECT;
        }

        function commit() {
          // lock width to height * aspect and clamp inside framebuffer
          roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
          roi.w = roi.h * ASPECT;
          roi.x = Math.min(Math.max(0, roi.x), cfg.frontResW - roi.w);
          roi.y = Math.min(Math.max(0, roi.y), cfg.frontResH - roi.h);
          // write polygon in TL,TR,BR,BL order for downstream code
          const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
          const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
          cfg.polyF = [[x0, y0], [x1, y0], [x1, y1], [x0, y1]];
          Config.save('polyF', cfg.polyF);
          drawPolyFront();
        }

        function toCanvas(e) {
          const r = frontOv.getBoundingClientRect();
          return {
            x: (e.clientX - r.left) * cfg.frontResW / r.width,
            y: (e.clientY - r.top) * cfg.frontResH / r.height
          };
        }

        // Drag-only gesture
        let dragStart, roiStart;
        frontOv?.addEventListener('pointerdown', e => {
          if (!Controller.isPreview()) return;
          frontOv.setPointerCapture(e.pointerId);
          dragStart = toCanvas(e);
          roiStart = { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
        });
        frontOv?.addEventListener('pointermove', e => {
          if (!dragStart || !Controller.isPreview()) return;
          const cur = toCanvas(e);
          roi.x = roiStart.x + (cur.x - dragStart.x);
          roi.y = roiStart.y + (cur.y - dragStart.y);
          commit();
        });
        function lift() { dragStart = null; roiStart = null; }
        frontOv?.addEventListener('pointerup', lift);
        frontOv?.addEventListener('pointercancel', lift);

        if (frontOv) frontOv.style.touchAction = 'none';
        const topMinInp = $('#topMinInp');
        const frontMinInp = $('#frontMinInp');
        if (topHInp) topHInp.value = cfg.topH;
        if (frontHInp) frontHInp.value = cfg.frontH;
        if (topMinInp) topMinInp.value = cfg.topMinArea;
        if (frontMinInp) frontMinInp.value = cfg.frontMinArea;

        topHInp?.addEventListener('input', e => {
          cfg.topH = Math.max(10, Math.min(cfg.topResH, +e.target.value));
          Config.save('topH', cfg.topH);
          topROI.h = cfg.topH;
          commitTop();
        });
        frontHInp?.addEventListener('input', e => {
          cfg.frontH = Math.max(10, Math.min(cfg.frontResH, +e.target.value));
          Config.save('frontH', cfg.frontH);
          roi.h = cfg.frontH;               // width is recomputed in commit()
          commit();
        });
        if (topMinInp) topMinInp.onchange = e => {
          cfg.topMinArea = Math.max(0, Math.min(1, +e.target.value));
          Config.save('topMinArea', cfg.topMinArea);
        };
        if (frontMinInp) frontMinInp.onchange = e => {
          cfg.frontMinArea = Math.max(0, +e.target.value);
          Config.save('frontMinArea', cfg.frontMinArea);
        };

        commit();
      })();

          if (urlI) urlI.value = cfg.url;
          if (selA) selA.value = teamA;
          if (selB) selB.value = teamB;

      if (urlI) urlI.onblur = () => {
        cfg.url = urlI.value;
        Config.save('url', cfg.url);
        if (urlWarn) urlWarn.textContent = '';
      };

        selA?.addEventListener('change', e => {
          teamA = cfg.teamA = e.target.value;
          Config.save('teamA', teamA);
          window.Game?.setTeams(cfg.teamA, cfg.teamB);
          domThrA = cfg.domThr[TEAM_INDICES[teamA]];
          satMinA = cfg.satMin[TEAM_INDICES[teamA]];
          yMinA = cfg.yMin[TEAM_INDICES[teamA]];
          yMaxA = cfg.yMax[TEAM_INDICES[teamA]];
          if (domAInput) domAInput.value = domThrA;
          if (satMinAInput) satMinAInput.value = satMinA;
          if (yMinAInput) yMinAInput.value = yMinA;
          if (yMaxAInput) yMaxAInput.value = yMaxA;
        });
        selB?.addEventListener('change', e => {
          teamB = cfg.teamB = e.target.value;
          Config.save('teamB', teamB);
          window.Game?.setTeams(cfg.teamA, cfg.teamB);
          domThrB = cfg.domThr[TEAM_INDICES[teamB]];
          satMinB = cfg.satMin[TEAM_INDICES[teamB]];
          yMinB = cfg.yMin[TEAM_INDICES[teamB]];
          yMaxB = cfg.yMax[TEAM_INDICES[teamB]];
          if (domBInput) domBInput.value = domThrB;
          if (satMinBInput) satMinBInput.value = satMinB;
          if (yMinBInput) yMinBInput.value = yMinB;
          if (yMaxBInput) yMaxBInput.value = yMaxB;
        });
    }

    return {
      bind,
      get cfg() { return cfg; },
      get Config() { return Config; }
    };
  })();

  window.Setup = Setup;
  if (window.App) window.App.Setup = Setup;
})();
