(function () {
  'use strict';
  window.createConfig = function createConfig(defaults) {
    let cfg;

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

      return cfg;
    }

    function save(name, value) {
      localStorage.setItem(name, JSON.stringify(value));
      if (cfg) {
        cfg[name] = value;
      }
    }

    function get() {
      return cfg;
    }

    return { load, save, get };
  };
})();
