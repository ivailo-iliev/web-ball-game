(function () {
  'use strict';

  let Config;

  const DEFAULTS = {
    // Single source of truth
    camW: 1920,
    camH: 1080,
    zoom: 1,
    topMinArea: 0.025,
    frontMinArea: 8000,
    teamA: 'green',
    teamB: 'blue',
    domThr: Array(4).fill(0.10),
    satMin: Array(4).fill(0.12),
    yMin: Array(4).fill(0.00),
    yMax: Array(4).fill(0.70),
    radiusPx: 18,
    url: 'http://192.168.43.1:8080/video',
    topRect: { x: 0, y: 0, w: 1920, h: 1080 },
    frontRect: { x: 0, y: 0, w: 0, h: 0 },
    topH: 1080,
    frontH: 220,
    topMode: 0,
    COLOR_TABLE: [
      0.00, 0.6, 0.35, 0.1, 1, 1,
      0.70, 0.6, 0.25, 0.9, 1, 1,
      0.50, 0.3, 0.20, 0.7, 1, 1,
      0.05, 0.7, 0.40, 0.2, 1, 1
    ]
  };

  const Setup = (() => {
    let cfg;
    let bound = false;

    // Clean decimal strings for UI + storage
    const toFixedStr = (n, d = 3) => {
      const num = Number(n);
      if (!Number.isFinite(num)) return '';
      return num
        .toFixed(d)
        .replace(/(\.\d*?[1-9])0+$/, '$1')
        .replace(/\.0+$/, '')
        .replace(/\.$/, '');
    };

    function recomputeSizes() {
      if (!cfg) return;
      cfg.topResW = u.toEvenInt(cfg.camW);
      cfg.topResH = u.toEvenInt(cfg.camH);
      cfg.frontResW = u.toEvenInt(cfg.topResW / cfg.zoom);
      cfg.frontResH = u.toEvenInt(cfg.topResH / cfg.zoom);
      if ($('#frontTex')) { $('#frontTex').width = cfg.frontResW; $('#frontTex').height = cfg.frontResH; }
      if ($('#frontOv')) { $('#frontOv').width = cfg.frontResW; $('#frontOv').height = cfg.frontResH; }
      if ($('#topTex')) { $('#topTex').width = cfg.topResW; $('#topTex').height = cfg.topResH; }
      if ($('#topOv')) { $('#topOv').width = cfg.topResW; $('#topOv').height = cfg.topResH; }
      if ($('#topHInp')) $('#topHInp').max = cfg.topResH;
      if ($('#frontHInp')) $('#frontHInp').max = cfg.frontResH;
    }

    // Single zoom setter: store the value only.
    function applyZoom(val) {
      if (!cfg) return;
      const z = Number(val);
      if (!Number.isFinite(z)) return; // ignore invalid
      cfg.zoom = u.clamp(z, 1, Number.POSITIVE_INFINITY);
      Config.save('zoom', cfg.zoom);
      recomputeSizes();
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
        const { createConfig } = window;
        Config = createConfig(DEFAULTS);
        Config.load();
        cfg = window.cfg;
        for (const k of Object.keys(DEFAULTS)) {
          if (localStorage.getItem(k) === null) {
            Config.save(k, cfg[k]);
          }
        }
        window.Config = Config;
      }
      // topMode should already be valid via defaults; do not coerce
      cfg.topMode = Number(cfg.topMode);
      Config.save('topMode', cfg.topMode);
      // Arrays are already typed in the cached config view; do not re-type here
      // Optional UI wiring (only stores values):
      // Zoom (single control or mirrored)
      $('#frontZoom')?.setAttribute('data-spinner', '');
      if ($('#frontZoom')) {
        $('#frontZoom').value = cfg.zoom;
        $('#frontZoom').addEventListener('input', e => applyZoom(e.target.value));
      }
      if ($('#zoom')) {
        $('#zoom').value = cfg.zoom;
        $('#zoom').addEventListener('input', e => applyZoom(e.target.value));
      }
      // Camera resolution (if you expose inputs)
      if ($('#camW')) {
        $('#camW').value = cfg.camW;
        $('#camW').addEventListener('change', e => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          cfg.camW = u.toEvenInt(u.clamp(n, 2, Number.MAX_SAFE_INTEGER));
          Config.save('camW', cfg.camW);
          e.target.value = cfg.camW;
          recomputeSizes();
        });
      }
      if ($('#camH')) {
        $('#camH').value = cfg.camH;
        $('#camH').addEventListener('change', e => {
          const n = Number(e.target.value);
          if (!Number.isFinite(n)) return;
          cfg.camH = u.toEvenInt(u.clamp(n, 2, Number.MAX_SAFE_INTEGER));
          Config.save('camH', cfg.camH);
          e.target.value = cfg.camH;
          recomputeSizes();
        });
      }
      recomputeSizes();
      if ($('#topMinInp')) {
        $('#topMinInp').value = cfg.topMinArea;
        $('#topMinInp').addEventListener('input', e => {
          cfg.topMinArea = Math.max(0, Math.min(1, +e.target.value));
          Config.save('topMinArea', cfg.topMinArea);
        });
      }

        const TEAM_INDICES = window.TEAM_INDICES;
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

        if ($('#domA')) $('#domA').value = toFixedStr(domThrA);
        if ($('#domB')) $('#domB').value = toFixedStr(domThrB);
        if ($('#satMinA')) $('#satMinA').value = toFixedStr(satMinA);
        if ($('#satMinB')) $('#satMinB').value = toFixedStr(satMinB);
        if ($('#yMinA')) $('#yMinA').value = toFixedStr(yMinA);
        if ($('#yMinB')) $('#yMinB').value = toFixedStr(yMinB);
        if ($('#yMaxA')) $('#yMaxA').value = toFixedStr(yMaxA);
        if ($('#yMaxB')) $('#yMaxB').value = toFixedStr(yMaxB);
        if ($('#radiusPx')) $('#radiusPx').value = cfg.radiusPx;

        $('#domA')?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamA]] = domThrA = +e.target.value;
          // Store trimmed strings → no FP junk in storage/UI; cache auto-rebuilt by save()
          Config.save('domThr', Array.from(cfg.domThr, toFixedStr));
        });
        $('#domB')?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamB]] = domThrB = +e.target.value;
          Config.save('domThr', Array.from(cfg.domThr, toFixedStr));
        });
        $('#satMinA')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamA]] = satMinA = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin, toFixedStr));
        });
        $('#satMinB')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamB]] = satMinB = +e.target.value;
          Config.save('satMin', Array.from(cfg.satMin, toFixedStr));
        });
        $('#yMinA')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamA]] = yMinA = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin, toFixedStr));
        });
        $('#yMinB')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamB]] = yMinB = +e.target.value;
          Config.save('yMin', Array.from(cfg.yMin, toFixedStr));
        });
        $('#yMaxA')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamA]] = yMaxA = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax, toFixedStr));
        });
        $('#yMaxB')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamB]] = yMaxB = +e.target.value;
          Config.save('yMax', Array.from(cfg.yMax, toFixedStr));
        });
        $('#radiusPx')?.addEventListener('input', e => {
          cfg.radiusPx = Math.max(0, +e.target.value);
          Config.save('radiusPx', cfg.radiusPx);
        });

        if ($('#topMode')) $('#topMode').value = cfg.topMode;
        $('#topMode')?.addEventListener('change', e => {
          cfg.topMode = +e.target.value;
          Config.save('topMode', cfg.topMode);
        });

        initNumberSpinners();
      $('#btnStart')?.addEventListener('click', () => Screen.snapTo(1));
      $('#btnTop')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = 'onlyTop'));
      $('#btnFront')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = 'onlyFront'));
      $('#btnBoth')?.addEventListener('click', () => $('#configScreen') && ($('#configScreen').className = ''));

      $('#start')?.addEventListener('click', () => {
        $('#start').disabled = true;
        const p = window.Controller?.startDetection?.();
        p?.catch(err => {
          if ($('#info')) $('#info').textContent = (err && err.message) ? err.message : String(err);
          $('#start').disabled = false;
          console.error(err);
        });
      });

    const topROI = { y: 0, h: cfg.topH };

    function drawRectTop() { window.PreviewGfx?.drawRect?.(cfg.topRect, 'lime', 'top'); }
    function drawRectFront() { window.PreviewGfx?.drawRect?.(cfg.frontRect, 'aqua', 'front'); }

    function commitTop() {
      topROI.y = Math.min(Math.max(0, topROI.y), cfg.topResH - topROI.h);
      const { y, h } = topROI;
      cfg.topRect = { x: 0, y, w: cfg.topResW, h };
      Config.save('topRect', cfg.topRect);
      drawRectTop();
    }

      if (cfg.topRect) {
        const y0 = cfg.topRect.y; const y1 = cfg.topRect.y + cfg.topRect.h;
        topROI.y = y0;
        topROI.h = y1 - y0;
      }

        if ($('#topOv')) {
          /* vertical drag on overlay */
          let dragY = null;
          $('#topOv').style.touchAction = 'none';
          $('#topOv').addEventListener('pointerdown', e => {
            if (!window.Controller?.isPreview) return;
            const r = $('#topOv').getBoundingClientRect();
            dragY = (e.clientY - r.top) * cfg.topResH / r.height;
            $('#topOv').setPointerCapture(e.pointerId);
          });
            $('#topOv').addEventListener('pointermove', e => {
              if (dragY == null || !window.Controller?.isPreview) return;
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
        if (cfg.frontRect) {
          const x0 = cfg.frontRect.x, y0 = cfg.frontRect.y;
          const x1 = x0 + cfg.frontRect.w, y1 = y0 + cfg.frontRect.h;
          roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          // re-lock width to height*aspect in case stored rect drifted
          roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
          roi.w = roi.h * frontAspect;
        }

        function commit() {
          // lock width to height * aspect and clamp inside framebuffer
          roi.h = Math.max(10, Math.min(cfg.frontResH, roi.h));
          roi.w = roi.h * frontAspect;
          roi.x = Math.min(Math.max(0, roi.x), cfg.frontResW - roi.w);
          roi.y = Math.min(Math.max(0, roi.y), cfg.frontResH - roi.h);
          // write rectangle (x,y,w,h) for downstream code
          const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
          const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
          cfg.frontRect = { x: x0, y: y0, w: (x1 - x0), h: (y1 - y0) };
          Config.save('frontRect', cfg.frontRect);
          drawRectFront();
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
            if (!window.Controller?.isPreview) return;
          $('#frontOv').setPointerCapture(e.pointerId);
          dragStart = toCanvas(e);
          roiStart = { x: roi.x, y: roi.y, w: roi.w, h: roi.h };
        });
          $('#frontOv')?.addEventListener('pointermove', e => {
            if (!dragStart || !window.Controller?.isPreview) return;
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
          if ($('#domA')) $('#domA').value = toFixedStr(domThrA);
          if ($('#satMinA')) $('#satMinA').value = toFixedStr(satMinA);
          if ($('#yMinA')) $('#yMinA').value = toFixedStr(yMinA);
          if ($('#yMaxA')) $('#yMaxA').value = toFixedStr(yMaxA);
        });
        $('#teamB')?.addEventListener('change', e => {
          teamB = cfg.teamB = e.target.value;
          Config.save('teamB', teamB);
          window.Game?.setTeams(cfg.teamA, cfg.teamB);
          domThrB = cfg.domThr[TEAM_INDICES[teamB]];
          satMinB = cfg.satMin[TEAM_INDICES[teamB]];
          yMinB = cfg.yMin[TEAM_INDICES[teamB]];
          yMaxB = cfg.yMax[TEAM_INDICES[teamB]];
          if ($('#domB')) $('#domB').value = toFixedStr(domThrB);
          if ($('#satMinB')) $('#satMinB').value = toFixedStr(satMinB);
          if ($('#yMinB')) $('#yMinB').value = toFixedStr(yMinB);
          if ($('#yMaxB')) $('#yMaxB').value = toFixedStr(yMaxB);
        });
    }

    return {
      bind,
      applyZoom,
      get cfg() { return cfg; }
    };
  })();

  Setup.bind();
})();
