(function () {
  'use strict';

  const TEAM_INDICES = Object.freeze({ red: 0, green: 1, blue: 2, yellow: 3 });
  window.TEAM_INDICES = TEAM_INDICES;

  window.createConfig = function createConfig(defaults) {
    let cfg;
    // --- Internal cached "runtime view" ---
    let _cached = null;

    // Helpers
    const asNum = (v) => (typeof v === 'string' ? +v : v);
    const f32 = (a) => (a != null ? Float32Array.from(a, asNum) : null);
    const rectMM = (r) => {
      // Unset or invalid -> return null (detection will use full-frame)
      if (!r) return null;
      const x0 = asNum(r.x), y0 = asNum(r.y), w = asNum(r.w), h = asNum(r.h);
      if (![x0, y0, w, h].every(Number.isFinite)) return null;
      const x1 = x0 + w, y1 = y0 + h;
      return { min: new Float32Array([x0, y0]), max: new Float32Array([x1, y1]) };
    };

    function buildCache() {
      // Start from the stored cfg and produce a runtime-friendly view.
      const view = Object.assign({}, cfg);
      // Precompute numeric/typed versions used by detection (same property names kept)
      view.domThr = f32(cfg.domThr);
      view.satMin = f32(cfg.satMin);
      view.yMin   = f32(cfg.yMin);
      view.yMax   = f32(cfg.yMax);
      // Add precomputed color indices & min/max rects (non-breaking: extra fields)
      view.colorA = TEAM_INDICES[cfg.teamA];
      view.colorB = TEAM_INDICES[cfg.teamB];
      view.topRectMM = rectMM(cfg.topRect);
      view.frontRectMM = rectMM(cfg.frontRect);

      // Resolved, color-dependent scalars (no validation, no fallbacks)
      const iA = view.colorA, iB = view.colorB;
      view.domThrA = view.domThr[iA];
      view.satMinA = view.satMin[iA];
      view.yMinA   = view.yMin[iA];
      view.yMaxA   = view.yMax[iA];
      view.domThrB = view.domThr[iB];
      view.satMinB = view.satMin[iB];
      view.yMinB   = view.yMin[iB];
      view.yMaxB   = view.yMax[iB];
      return view;
    }

    function rebuildCache() {
      if (!cfg) {
        _cached = null;
        return;
      }
      // Keep object identity stable so existing references to Config.get() stay valid
      const next = buildCache();
      if (!_cached) {
        _cached = next;
      } else {
        // Remove keys that disappeared
        for (const k in _cached) if (!(k in next)) delete _cached[k];
        // Update/insert keys in place
        Object.assign(_cached, next);
      }
    }

    function load(opts = {}) {
      cfg = {};
      for (const [name, def] of Object.entries(defaults)) {
        const raw = localStorage.getItem(name);
        try {
          cfg[name] = raw !== null ? JSON.parse(raw) : def;
        } catch (e) {
          cfg[name] = def;
        }
      }

      if (opts.teamIndices && typeof opts.hsvRangeF16 === 'function') {
        cfg.f16Ranges = {};
        for (const t of Object.keys(opts.teamIndices)) {
          cfg.f16Ranges[t] = opts.hsvRangeF16(t);
        }
      }

      rebuildCache();

      return cfg;
    }

    function save(name, value) {
      localStorage.setItem(name, JSON.stringify(value));
      if (cfg) {
        cfg[name] = value;
        // Any persisted change may affect detection; keep cache hot & ready.
        rebuildCache();
      } else {
        _cached = null;
      }
    }

    function get() {
      // Always return the cached, detection-ready view when available.
      if (!_cached) {
        if (!cfg) {
          return cfg;
        }
        _cached = buildCache();
      }
      return _cached;
    }

    const api = { load, save, get };

    Object.defineProperty(api, 'cfg', {
      enumerable: true,
      configurable: true,
      get
    });

    Object.defineProperty(window, 'cfg', {
      configurable: true,
      get
    });

    return api;
  };
})();
