(function () {
  'use strict';

  let Config, PreviewGfx, Controller, Feeds;
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
  // Detection thresholds: defaults must be at min or max range
  const DOM_THR_DEFAULT = 0.0;
  const SATMIN_DEFAULT  = 0.0;
  const YMIN_DEFAULT    = 0.0;
  const YMAX_DEFAULT    = 1.0;
  const RADIUS_DEFAULT  = 18;

  const Setup = (() => {
    let cfg;
    let bound = false;

    function applyFrontZoom(val) {
      if (!cfg) return;
      cfg.frontZoom = Math.max(1, +val);
      cfg.frontResW = Math.round(CAM_W / cfg.frontZoom) & ~1;
      cfg.frontResH = Math.round(cfg.frontResW * ASPECT) & ~1;
      Config.save('frontZoom', cfg.frontZoom);
      Config.save('frontResW', cfg.frontResW);
      Config.save('frontResH', cfg.frontResH);
      if ($('#frontTex')) { $('#frontTex').width = cfg.frontResW; $('#frontTex').height = cfg.frontResH; }
      if ($('#frontOv')) { $('#frontOv').width = cfg.frontResW; $('#frontOv').height = cfg.frontResH; }
      Feeds?.setCrop?.(cfg.frontResW, cfg.frontResH);
    }

    function applyTopZoom(val) {
      if (!cfg) return;
      cfg.topZoom = Math.max(1, +val);
      cfg.topResW = Math.round(CAM_W / cfg.topZoom) & ~1;
      cfg.topResH = Math.round(cfg.topResW * ASPECT) & ~1;
      Config.save('topZoom', cfg.topZoom);
      Config.save('topResW', cfg.topResW);
      Config.save('topResH', cfg.topResH);
      if ($('#topTex')) { $('#topTex').width = cfg.topResW; $('#topTex').height = cfg.topResH; }
      if ($('#topOv')) { $('#topOv').width = cfg.topResW; $('#topOv').height = cfg.topResH; }
      Feeds?.setCrop?.(cfg.topResW, cfg.topResH);
    }

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
          onclick: () => {
            input.stepDown();
            input.dispatchEvent(new Event('input', { bubbles: true }));
            update();
          }
        });
        const btnUp = Object.assign(document.createElement('button'), {
          type: 'button',
          className: 'up',
          textContent: '+',
          onclick: () => {
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
      if (bound) return;
      bound = true;
      if (!Config) {
        Config = window.Config || Config;
        PreviewGfx = window.PreviewGfx || PreviewGfx;
        Controller = window.Controller || Controller;
        Feeds = window.Feeds || Feeds;
      }
      if (!Config) {
        const { createConfig } = window;
        // Default to full-frame, unity zoom
        const DEFAULT_CROP_W = CAM_W;
        const DEFAULT_CROP_H = CAM_H;
        const DEFAULT_ZOOM = 1;
        const defaults = {
          topZoom: DEFAULT_ZOOM,
          frontZoom: DEFAULT_ZOOM,
          topResW: DEFAULT_CROP_W,
          topResH: DEFAULT_CROP_H,
          frontResW: DEFAULT_CROP_W,
          frontResH: DEFAULT_CROP_H,
          topH: DEFAULT_CROP_H,
          frontH: DEFAULT_CROP_H,
          topMinArea: 0,
          frontMinArea: 0,
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
        if ($('#topTex')) { $('#topTex').width = cfg.topResW; $('#topTex').height = cfg.topResH; }
        if ($('#topOv')) { $('#topOv').width = cfg.topResW; $('#topOv').height = cfg.topResH; }
        if ($('#frontTex')) { $('#frontTex').width = cfg.frontResW; $('#frontTex').height = cfg.frontResH; }
        if ($('#frontOv')) { $('#frontOv').width = cfg.frontResW; $('#frontOv').height = cfg.frontResH; }
        if ($('#topHInp')) $('#topHInp').max = cfg.topResH;
        if ($('#frontHInp')) $('#frontHInp').max = cfg.frontResH;
        $('#frontZoom')?.setAttribute('data-spinner', '');
        if ($('#frontZoom')) {
          $('#frontZoom').value = cfg.frontZoom;
          $('#frontZoom').addEventListener('input', e => {
            applyFrontZoom(e.target.value);
          });
        }
        if ($('#zoom')) {
          $('#zoom').value = cfg.topZoom;
          $('#zoom').addEventListener('input', e => {
            applyTopZoom(e.target.value);
          });
        }
        if ($('#topMinInp')) {
          $('#topMinInp').value = cfg.topMinArea;
          $('#topMinInp').addEventListener('input', e => {
          cfg.topMinArea = Math.max(0, Math.min(1, +e.target.value));
          Config.save('topMinArea', cfg.topMinArea);
        });
        }

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

        if ($('#domA')) $('#domA').value = domThrA;
        if ($('#domB')) $('#domB').value = domThrB;
        if ($('#satMinA')) $('#satMinA').value = satMinA;
        if ($('#satMinB')) $('#satMinB').value = satMinB;
        if ($('#yMinA')) $('#yMinA').value = yMinA;
        if ($('#yMinB')) $('#yMinB').value = yMinB;
        if ($('#yMaxA')) $('#yMaxA').value = yMaxA;
        if ($('#yMaxB')) $('#yMaxB').value = yMaxB;
        if ($('#radiusPx')) $('#radiusPx').value = cfg.radiusPx;

        $('#domA')?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamA]] = domThrA = +e.target.value;
          Config.save('domThr', Array.from(cfg.domThr));
        });
        $('#domB')?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamB]] = domThrB = +e.target.value;
          Config.save('domThr', Array.from(cfg.domThr));
        });
        $('#satMinA')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamA]] = satMinA = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin));
        });
        $('#satMinB')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamB]] = satMinB = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin));
        });
        $('#yMinA')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamA]] = yMinA = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin));
        });
        $('#yMinB')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamB]] = yMinB = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin));
        });
        $('#yMaxA')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamA]] = yMaxA = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax));
        });
        $('#yMaxB')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamB]] = yMaxB = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax));
        });
        $('#radiusPx')?.addEventListener('input', e => {
          cfg.radiusPx = Math.max(0, +e.target.value);
          Config.save('radiusPx', cfg.radiusPx);
        });

        if ($('#topMode')) $('#topMode').value = cfg.topMode;
        $('#topMode')?.addEventListener('change', e => {
          cfg.topMode = e.target.value;
          Config.save('topMode', cfg.topMode);
        });

        initNumberSpinners();
      $('#btnStart')?.addEventListener('click', () => snapTo(1));
      $('#btnTop')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = 'onlyTop'));
      $('#btnFront')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = 'onlyFront'));
      $('#btnBoth')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = ''));

      let infoBase = '';
      let lastFrameTS;

      $('#start')?.addEventListener('click', async () => {
        $('#start').disabled = true;
        infoBase = '';
        try {
          if (!await Feeds.init()) {
            if ($('#info')) $('#info').textContent = 'Feed init failed';
            $('#start').disabled = false;
            return;
          }
          updateFrontCrop();
          let busy = false;
          const loop = async () => {
            const frame = await Feeds.frontFrame();
            if (!frame) { requestAnimationFrame(loop); return; }
            if (busy) { frame.close(); requestAnimationFrame(loop); return; }
            const now = performance.now();
            if (lastFrameTS !== undefined && $('#info')) {
              const fps = 1000 / (now - lastFrameTS);
              $('#info').textContent = `${infoBase} ${fps.toFixed(1)} fps`;
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
                previewCanvas: $('#gfx'),
                preview: true,
                activeA: true, activeB: true,
                flipY: true,
                radiusPx: cfg.radiusPx,
              });
              if (resized && $('#gfx')) {
                $('#gfx').width = frame.displayWidth;
                $('#gfx').height = frame.displayHeight;
                infoBase = `Running ${w}×${h}, shader.wgsl compute+render (VideoFrame).`;
                if ($('#info')) $('#info').textContent = infoBase;
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
          };
          requestAnimationFrame(loop);
        } catch (err) {
          if ($('#info')) $('#info').textContent = (err && err.message) ? err.message : String(err);
          $('#start').disabled = false;
          console.error(err);
        }
      });

    const topROI = { y: 0, h: cfg.topH };

    function drawPolyTop() { PreviewGfx?.drawROI?.(cfg.polyT, 'lime', 'top'); }
    function drawPolyFront() { PreviewGfx?.drawROI?.(cfg.polyF, 'aqua', 'front'); }

    function commitTop() {
      topROI.y = Math.min(Math.max(0, topROI.y), cfg.topResH - topROI.h);
      const { y, h } = topROI;
      cfg.polyT = [[0, y], [cfg.topResW, y], [cfg.topResW, y + h], [0, y + h]];
      Config.save('polyT', cfg.polyT);
      drawPolyTop();
    }

      if (cfg.polyT?.length === 4) {
        const ys = cfg.polyT.map(p => p[1]);
        topROI.y = Math.min(...ys);
        topROI.h = Math.max(...ys) - topROI.y;
      }

        if ($('#topOv')) {
          /* vertical drag on overlay */
          let dragY = null;
          $('#topOv').style.touchAction = 'none';
          $('#topOv').addEventListener('pointerdown', e => {
            if (!Controller?.isPreview?.()) return;
            const r = $('#topOv').getBoundingClientRect();
            dragY = (e.clientY - r.top) * cfg.topResH / r.height;
            $('#topOv').setPointerCapture(e.pointerId);
          });
            $('#topOv').addEventListener('pointermove', e => {
              if (dragY == null || !Controller?.isPreview?.()) return;
            const r = $('#topOv').getBoundingClientRect();
            const curY = (e.clientY - r.top) * cfg.topResH / r.height;
            topROI.y += curY - dragY;
            dragY = curY;
            commitTop();
          });
          $('#topOv').addEventListener('pointerup', () => dragY = null);
          $('#topOv').addEventListener('pointercancel', () => dragY = null);
        }

      commitTop();

        // Front ROI: fixed aspect, height-driven; gesture = drag only
        const frontAspect = cfg.frontResW / cfg.frontResH;
        let roi = { x: 0, y: 0, w: cfg.frontH * frontAspect, h: cfg.frontH };
        if (cfg.polyF?.length === 4) {
          const xs = cfg.polyF.map(p => p[0]), ys = cfg.polyF.map(p => p[1]);
          const x0 = Math.min(...xs), x1 = Math.max(...xs);
          const y0 = Math.min(...ys), y1 = Math.max(...ys);
          roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          // re-lock width to height*aspect in case stored poly drifted
            roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
            roi.w = roi.h * frontAspect;
        }

        function commit() {
          // lock width to height * aspect and clamp inside framebuffer
          roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
          roi.w = roi.h * frontAspect;
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
          const r = $('#frontOv').getBoundingClientRect();
          return {
            x: (e.clientX - r.left) * cfg.frontResW / r.width,
            y: (e.clientY - r.top) * cfg.frontResH / r.height
          };
        }

        // Drag-only gesture
        let dragStart, roiStart;
          $('#frontOv')?.addEventListener('pointerdown', e => {
            if (!Controller?.isPreview?.()) return;
          $('#frontOv').setPointerCapture(e.pointerId);
          dragStart = toCanvas(e);
          roiStart = { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
        });
          $('#frontOv')?.addEventListener('pointermove', e => {
            if (!dragStart || !Controller?.isPreview?.()) return;
          const cur = toCanvas(e);
          roi.x = roiStart.x + (cur.x - dragStart.x);
          roi.y = roiStart.y + (cur.y - dragStart.y);
          commit();
        });
        const lift = () => { dragStart = null; roiStart = null; };
        $('#frontOv')?.addEventListener('pointerup', lift);
        $('#frontOv')?.addEventListener('pointercancel', lift);

        if ($('#frontOv')) $('#frontOv').style.touchAction = 'none';
        if ($('#topHInp')) $('#topHInp').value = cfg.topH;
        if ($('#frontHInp')) $('#frontHInp').value = cfg.frontH;
        if ($('#topMinInp')) $('#topMinInp').value = cfg.topMinArea;
        if ($('#frontMinInp')) $('#frontMinInp').value = cfg.frontMinArea;

        $('#topHInp')?.addEventListener('input', e => {
          cfg.topH = Math.max(10, Math.min(cfg.topResH, +e.target.value));
          Config.save('topH', cfg.topH);
          topROI.h = cfg.topH;
          commitTop();
        });
        $('#frontHInp')?.addEventListener('input', e => {
          cfg.frontH = Math.max(10, Math.min(cfg.frontResH, +e.target.value));
          Config.save('frontH', cfg.frontH);
          roi.h = cfg.frontH;               // width is recomputed in commit()
          commit();
        });
        if ($('#topMinInp')) $('#topMinInp').onchange = e => {
          cfg.topMinArea = Math.max(0, Math.min(1, +e.target.value));
          Config.save('topMinArea', cfg.topMinArea);
        };
        if ($('#frontMinInp')) $('#frontMinInp').onchange = e => {
          cfg.frontMinArea = Math.max(0, +e.target.value);
          Config.save('frontMinArea', cfg.frontMinArea);
        };

        commit();

        if ($('#topUrl')) $('#topUrl').value = cfg.url;
        if ($('#teamA')) $('#teamA').value = teamA;
        if ($('#teamB')) $('#teamB').value = teamB;

        if ($('#topUrl')) $('#topUrl').onblur = () => {
          cfg.url = $('#topUrl').value;
          Config.save('url', cfg.url);
          if ($('#urlWarn')) $('#urlWarn').textContent = '';
        };

        $('#teamA')?.addEventListener('change', e => {
          teamA = cfg.teamA = e.target.value;
          Config.save('teamA', teamA);
          window.Game?.setTeams(cfg.teamA, cfg.teamB);
          domThrA = cfg.domThr[TEAM_INDICES[teamA]];
          satMinA = cfg.satMin[TEAM_INDICES[teamA]];
          yMinA = cfg.yMin[TEAM_INDICES[teamA]];
          yMaxA = cfg.yMax[TEAM_INDICES[teamA]];
          if ($('#domA')) $('#domA').value = domThrA;
          if ($('#satMinA')) $('#satMinA').value = satMinA;
          if ($('#yMinA')) $('#yMinA').value = yMinA;
          if ($('#yMaxA')) $('#yMaxA').value = yMaxA;
        });
        $('#teamB')?.addEventListener('change', e => {
          teamB = cfg.teamB = e.target.value;
          Config.save('teamB', teamB);
          window.Game?.setTeams(cfg.teamA, cfg.teamB);
          domThrB = cfg.domThr[TEAM_INDICES[teamB]];
          satMinB = cfg.satMin[TEAM_INDICES[teamB]];
          yMinB = cfg.yMin[TEAM_INDICES[teamB]];
          yMaxB = cfg.yMax[TEAM_INDICES[teamB]];
          if ($('#domB')) $('#domB').value = domThrB;
          if ($('#satMinB')) $('#satMinB').value = satMinB;
          if ($('#yMinB')) $('#yMinB').value = yMinB;
          if ($('#yMaxB')) $('#yMaxB').value = yMaxB;
        });
    }

    function updateFrontCrop() {
      if (!Feeds) return;
      const cfg = Config.get();
      const zEl = $('#frontZoom');
      const z = Feeds.frontCropRatio();
      if (zEl) zEl.value = z.toFixed(2);
      cfg.frontZoom = z;
      cfg.frontResW = Math.round(CAM_W / z) & ~1;
      cfg.frontResH = Math.round(cfg.frontResW * ASPECT) & ~1;
      Config.save('frontZoom', cfg.frontZoom);
      Config.save('frontResW', cfg.frontResW);
      Config.save('frontResH', cfg.frontResH);
      if ($('#frontTex')) { $('#frontTex').width = cfg.frontResW; $('#frontTex').height = cfg.frontResH; }
      if ($('#frontOv')) { $('#frontOv').width = cfg.frontResW; $('#frontOv').height = cfg.frontResH; }
    }

    return {
      bind,
      updateFrontCrop,
      applyFrontZoom,
      applyTopZoom,
      get cfg() { return cfg; }
    };
  })();

  window.Setup = Setup;
  if (document.readyState !== 'loading') {
    Setup.bind();
  } else {
    window.addEventListener('DOMContentLoaded', () => Setup.bind(), { once: true });
  }
})();
