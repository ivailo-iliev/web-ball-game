(function () {
  'use strict';

  let Config;

  const DEFAULTS = {
    // Single source of truth
    camW: 1920,
    camH: 886,
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
    topRect: { x: 0, y: 0, w: 1920, h: 886 },
    frontRect: { x: 0, y: 0, w: 1920, h: 886 },
    topH: 886,
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
    const toFixedArray = (values) => Array.from(values, value => toFixedStr(value));

    let frontResW = 0;
    let frontResH = 0;
    function recomputeSizes() {
      if (!cfg) return;
      cfg.topResW = u.toEvenInt(cfg.camW);
      cfg.topResH = u.toEvenInt(cfg.camH);
      cfg.frontResW = u.toEvenInt(cfg.camW / cfg.zoom);
      cfg.frontResH = u.toEvenInt(cfg.camH / cfg.zoom);
      frontResW = cfg.frontResW;
      frontResH = cfg.frontResH;
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
            Config.save(k, DEFAULTS[k]);
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
          cfg.topMinArea = +e.target.value;
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
          Config.save('domThr', toFixedArray(cfg.domThr));
        });
        $('#domB')?.addEventListener('input', e => {
          cfg.domThr[TEAM_INDICES[teamB]] = domThrB = +e.target.value;
          Config.save('domThr', toFixedArray(cfg.domThr));
        });
        $('#satMinA')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamA]] = satMinA = +e.target.value;
          Config.save('satMin', toFixedArray(cfg.satMin));
        });
        $('#satMinB')?.addEventListener('input', e => {
          cfg.satMin[TEAM_INDICES[teamB]] = satMinB = +e.target.value;
          Config.save('satMin', toFixedArray(cfg.satMin));
        });
        $('#yMinA')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamA]] = yMinA = +e.target.value;
          Config.save('yMin', toFixedArray(cfg.yMin));
        });
        $('#yMinB')?.addEventListener('input', e => {
          cfg.yMin[TEAM_INDICES[teamB]] = yMinB = +e.target.value;
          Config.save('yMin', toFixedArray(cfg.yMin));
        });
        $('#yMaxA')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamA]] = yMaxA = +e.target.value;
          Config.save('yMax', toFixedArray(cfg.yMax));
        });
        $('#yMaxB')?.addEventListener('input', e => {
          cfg.yMax[TEAM_INDICES[teamB]] = yMaxB = +e.target.value;
          Config.save('yMax', toFixedArray(cfg.yMax));
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
      $('#btnRefresh')?.addEventListener('click', () => window.location.reload());

      const VIEW_ICONS = {
        onlyFront: '⛶',
        onlyTop: '⇥',
        both: '🀱'
      };
      const NEXT_VIEW_MODE = {
        onlyFront: 'onlyTop',
        onlyTop: 'both',
        both: 'onlyFront'
      };

      let viewMode =
        ($('#configScreen') && NEXT_VIEW_MODE[$('#configScreen').className])
          ? $('#configScreen').className
          : 'onlyFront';
      if ($('#btnViewCycle') && $('#btnViewCycle').textContent !== VIEW_ICONS[viewMode]) {
        $('#btnViewCycle').textContent = VIEW_ICONS[viewMode];
      }

      $('#btnNumberInputs')?.addEventListener('click', () => {
        $('#cfg')?.classList.toggle('hide-number-inputs');
      });

      $('#btnViewCycle')?.addEventListener('click', () => {
        viewMode = NEXT_VIEW_MODE[viewMode] || 'onlyFront';
        if ($('#btnViewCycle')) $('#btnViewCycle').textContent = VIEW_ICONS[viewMode];
        if ($('#configScreen') && $('#configScreen').className !== viewMode) $('#configScreen').className = viewMode;
      });

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
      const maxTopY = cfg.topResH - topROI.h;
      topROI.y = u.clamp(topROI.y, 0, maxTopY);
      const { y, h } = topROI;
      cfg.topRect = { x: 0, y, w: cfg.topResW, h };
      Config.save('topRect', cfg.topRect);
      recomputeSizes();
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
        const CALIBRATION_TIMEOUT_MS = 1500;
        const CALIBRATION_CORNER_WEIGHT = 64;
        const QUADRANT_SPECS = Object.freeze({
          TL: { x0: 0, x1: () => Math.floor(frontResW / 2), y0: 0, y1: () => Math.floor(frontResH / 2), targetX: bounds => bounds.x0, targetY: bounds => bounds.y0 },
          TR: { x0: () => Math.floor(frontResW / 2), x1: () => frontResW, y0: 0, y1: () => Math.floor(frontResH / 2), targetX: bounds => bounds.x1 - 1, targetY: bounds => bounds.y0 },
          BL: { x0: 0, x1: () => Math.floor(frontResW / 2), y0: () => Math.floor(frontResH / 2), y1: () => frontResH, targetX: bounds => bounds.x0, targetY: bounds => bounds.y1 - 1 },
          BR: { x0: () => Math.floor(frontResW / 2), x1: () => frontResW, y0: () => Math.floor(frontResH / 2), y1: () => frontResH, targetX: bounds => bounds.x1 - 1, targetY: bounds => bounds.y1 - 1 }
        });
        const frontAspect = () => frontResW / frontResH;
        let roi = { x: 0, y: 0, w: cfg.frontH * frontAspect(), h: cfg.frontH };
        let calibrationCanvas, calibrationCtx;
        let calibrating = false;
        if (cfg.frontRect) {
          const x0 = cfg.frontRect.x, y0 = cfg.frontRect.y;
          const x1 = x0 + cfg.frontRect.w, y1 = y0 + cfg.frontRect.h;
          roi = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
          // re-lock width to height*aspect in case stored rect drifted
          roi.h = u.clamp(roi.h, 10, frontResH);
          roi.w = roi.h * frontAspect();
        }

        function setCalibrationStatus(message = '', state = '') {
          const el = $('#calibStatus');
          if (!el) return;
          el.textContent = message;
          if (state) el.dataset.state = state;
          else delete el.dataset.state;
        }

        function syncFrontRect(nextRect) {
          const x = u.clamp(Math.round(nextRect.x), 0, Math.max(0, frontResW - 1));
          const y = u.clamp(Math.round(nextRect.y), 0, Math.max(0, frontResH - 1));
          const w = u.clamp(Math.round(nextRect.w), 1, frontResW - x);
          const h = u.clamp(Math.round(nextRect.h), 1, frontResH - y);
          roi = { x, y, w, h };
          cfg.frontRect = { x, y, w, h };
          Config.save('frontRect', cfg.frontRect);
          cfg.frontH = h;
          Config.save('frontH', cfg.frontH);
          if ($('#frontHInp')) $('#frontHInp').value = cfg.frontH;
          recomputeSizes();
          drawRectFront();
        }

        function commit() {
          // lock width to height * aspect and clamp inside framebuffer
          roi.h = u.clamp(roi.h, 10, frontResH);
          roi.w = roi.h * frontAspect();
          roi.x = u.clamp(roi.x, 0, frontResW - roi.w);
          roi.y = u.clamp(roi.y, 0, frontResH - roi.h);
          // write rectangle (x,y,w,h) for downstream code
          const x0 = Math.round(roi.x), y0 = Math.round(roi.y);
          const x1 = Math.round(roi.x + roi.w), y1 = Math.round(roi.y + roi.h);
          syncFrontRect({ x: x0, y: y0, w: (x1 - x0), h: (y1 - y0) });
        }

        function ensureCalibrationContext() {
          if (!calibrationCanvas) {
            calibrationCanvas = document.createElement('canvas');
            calibrationCtx = calibrationCanvas.getContext('2d', { willReadFrequently: true });
          }
          if (!calibrationCtx) throw new Error('2D calibration canvas unavailable');
          if (calibrationCanvas.width !== frontResW) calibrationCanvas.width = frontResW;
          if (calibrationCanvas.height !== frontResH) calibrationCanvas.height = frontResH;
          return calibrationCtx;
        }

        function quadrantBounds(name) {
          const spec = QUADRANT_SPECS[name];
          return {
            x0: typeof spec.x0 === 'function' ? spec.x0() : spec.x0,
            x1: typeof spec.x1 === 'function' ? spec.x1() : spec.x1,
            y0: typeof spec.y0 === 'function' ? spec.y0() : spec.y0,
            y1: typeof spec.y1 === 'function' ? spec.y1() : spec.y1,
            targetX: 0,
            targetY: 0
          };
        }

        function pickQuadrantCorner(imageData, name) {
          const bounds = quadrantBounds(name);
          bounds.targetX = QUADRANT_SPECS[name].targetX(bounds);
          bounds.targetY = QUADRANT_SPECS[name].targetY(bounds);
          const quadW = Math.max(1, bounds.x1 - bounds.x0);
          const quadH = Math.max(1, bounds.y1 - bounds.y0);
          let best = null;
          const { data, width } = imageData;

          for (let y = bounds.y0; y < bounds.y1; y++) {
            for (let x = bounds.x0; x < bounds.x1; x++) {
              const idx = (y * width + x) * 4;
              const r = data[idx];
              const g = data[idx + 1];
              const b = data[idx + 2];
              const magentaScore = r + b - 2 * g;
              const dx = Math.abs(x - bounds.targetX) / Math.max(1, quadW - 1);
              const dy = Math.abs(y - bounds.targetY) / Math.max(1, quadH - 1);
              const cornerPenalty = (dx + dy) / 2;
              const effectiveScore = magentaScore - CALIBRATION_CORNER_WEIGHT * cornerPenalty;
              if (
                !best ||
                effectiveScore > best.effectiveScore ||
                (effectiveScore === best.effectiveScore && magentaScore > best.magentaScore) ||
                (effectiveScore === best.effectiveScore && magentaScore === best.magentaScore && cornerPenalty < best.cornerPenalty)
              ) {
                best = { x, y, magentaScore, cornerPenalty, effectiveScore };
              }
            }
          }

          if (!best) throw new Error('Calibration scan failed in ' + name + ' quadrant');
          return best;
        }

        function fitCalibratedRect(points) {
          const xs = points.map(point => point.x);
          const ys = points.map(point => point.y);
          const left = Math.min(...xs);
          const right = Math.max(...xs) + 1;
          const top = Math.min(...ys);
          const bottom = Math.max(...ys) + 1;
          const rawW = Math.max(1, right - left);
          const rawH = Math.max(1, bottom - top);
          let w = rawW;
          let h = rawH;
          const aspect = frontAspect();
          if (w / h < aspect) w = h * aspect;
          else h = w / aspect;
          w = Math.min(w, frontResW);
          h = Math.min(h, frontResH);
          let x = ((left + right) / 2) - (w / 2);
          let y = ((top + bottom) / 2) - (h / 2);
          x = u.clamp(x, 0, frontResW - w);
          y = u.clamp(y, 0, frontResH - h);
          const x0 = u.clamp(Math.round(x), 0, Math.max(0, frontResW - 1));
          const y0 = u.clamp(Math.round(y), 0, Math.max(0, frontResH - 1));
          const x1 = u.clamp(Math.round(x + w), x0 + 1, frontResW);
          const y1 = u.clamp(Math.round(y + h), y0 + 1, frontResH);
          return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
        }

        async function calibrateFrontROI() {
          if (calibrating) return;
          if (!window.Feeds?.captureFrontCalibrationFrame) {
            setCalibrationStatus('Calibration feed unavailable', 'error');
            return;
          }

          calibrating = true;
          if ($('#btnCalibrate')) $('#btnCalibrate').disabled = true;
          setCalibrationStatus('Calibrating...');

          let frame;
          try {
            frame = await window.Feeds.captureFrontCalibrationFrame({ timeoutMs: CALIBRATION_TIMEOUT_MS });
            if (!frame) throw new Error('Front frame not ready for calibration');
            const ctx = ensureCalibrationContext();
            ctx.clearRect(0, 0, frontResW, frontResH);
            ctx.drawImage(frame, 0, 0, frontResW, frontResH);
            const imageData = ctx.getImageData(0, 0, frontResW, frontResH);
            const points = ['TL', 'TR', 'BL', 'BR'].map(name => pickQuadrantCorner(imageData, name));
            const rect = fitCalibratedRect(points);
            syncFrontRect(rect);
            setCalibrationStatus('Calibrated.', 'ok');
          } catch (err) {
            setCalibrationStatus((err && err.message) ? err.message : 'Calibration failed', 'error');
            console.error(err);
          } finally {
            if (frame) frame.close();
            if ($('#btnCalibrate')) $('#btnCalibrate').disabled = false;
            calibrating = false;
          }
        }

        function toCanvas(e) {
          const r = $('#frontOv').getBoundingClientRect();
          return {
            x: (e.clientX - r.left) * frontResW / r.width,
            y: (e.clientY - r.top) * frontResH / r.height
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

        function isTypingTarget(el) {
          if (!el) return false;
          const tag = el.tagName;
          return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
        }

        // Keyboard nudges in front preview:
        // WASD moves ROI by 1px; [ / ] resize ROI by 1px with fixed aspect ratio.
        window.addEventListener('keydown', e => {
          if (!window.Controller?.isPreview || isTypingTarget(e.target)) return;

          let handled = true;
          switch (e.key.toLowerCase()) {
            case 'w':
              roi.y -= 1;
              break;
            case 'a':
              roi.x -= 1;
              break;
            case 's':
              roi.y += 1;
              break;
            case 'd':
              roi.x += 1;
              break;
            case '[': {
              const nextH = u.clamp(Math.round(roi.h + 1), 10, frontResH);
              const nextW = nextH * frontAspect();
              roi.x -= (nextW - roi.w) / 2;
              roi.y -= (nextH - roi.h) / 2;
              roi.h = nextH;
              break;
            }
            case ']': {
              const nextH = u.clamp(Math.round(roi.h - 1), 10, frontResH);
              const nextW = nextH * frontAspect();
              roi.x -= (nextW - roi.w) / 2;
              roi.y -= (nextH - roi.h) / 2;
              roi.h = nextH;
              break;
            }
            default:
              handled = false;
          }

          if (!handled) return;
          e.preventDefault();
          cfg.frontH = Math.round(roi.h);
          Config.save('frontH', cfg.frontH);
          if ($('#frontHInp')) $('#frontHInp').value = cfg.frontH;
          commit();
        });

        if ($('#frontOv')) $('#frontOv').style.touchAction = 'none';
        if ($('#topHInp')) $('#topHInp').value = cfg.topH;
        if ($('#frontHInp')) $('#frontHInp').value = cfg.frontH;
        if ($('#topMinInp')) $('#topMinInp').value = cfg.topMinArea;
        if ($('#frontMinInp')) $('#frontMinInp').value = cfg.frontMinArea;

        $('#topHInp')?.addEventListener('input', e => {
          cfg.topH = u.clamp(+e.target.value, 10, cfg.topResH);
          Config.save('topH', cfg.topH);
          topROI.h = cfg.topH;
          commitTop();
        });
        $('#frontHInp')?.addEventListener('input', e => {
          cfg.frontH = u.clamp(+e.target.value, 10, frontResH);
          Config.save('frontH', cfg.frontH);
          roi.h = cfg.frontH;               // width is recomputed in commit()
          commit();
        });
        if ($('#frontMinInp')) $('#frontMinInp').onchange = e => {
          cfg.frontMinArea = +e.target.value;
          Config.save('frontMinArea', cfg.frontMinArea);
        };

        $('#btnCalibrate')?.addEventListener('click', () => {
          void calibrateFrontROI();
        });

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
