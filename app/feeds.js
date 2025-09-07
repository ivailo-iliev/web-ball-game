(function () {
  'use strict';

  const Feeds = (() => {
    let Config, cfg;
    let videoTop, track, dc, videoWorker;
    let lastFrame;

    const workerSrc = `self.postMessage({ op: 'supports', value: !!self.MediaStreamTrackProcessor });
self.onmessage = async ({ data }) => {
  const post = frame => self.postMessage(frame, [frame]);
  const readFrames = async reader => {
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      post(frame);
    }
  };
  const { op, track, stream } = data || {};
  if (op === 'init-track' && track) {
    const processor = new MediaStreamTrackProcessor({ track });
    await readFrames(processor.readable.getReader());
  } else if (op === 'init-stream' && stream) {
    await readFrames(stream.getReader());
  }
};`;
    const workerURL = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));

    function startVideoWorker(track, onFrame) {
      const worker = new Worker(workerURL);
      let initialized = false;
      worker.onmessage = ({ data }) => {
        if (!initialized && data?.op === 'supports') {
          initialized = true;
          if (data.value) {
            worker.postMessage({ op: 'init-track', track }, [track]);
          } else if (window.MediaStreamTrackProcessor) {
            const processor = new MediaStreamTrackProcessor({ track });
            worker.postMessage({ op: 'init-stream', stream: processor.readable }, [processor.readable]);
          }
          return;
        }
        onFrame(data);
      };
      return worker;
    }

    // Crop = Zoom (centered). Uses only Config.zoom (>= 1).
    function zoomFrame(frame) {
      const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
      const conf = (Config?.get?.()) || cfg || {};
      const zoom = u.clamp(Number(conf.zoom) || 1, 1, Number.POSITIVE_INFINITY);
      // compute even crop size from current frame rect using zoom ratio
      let cropW = u.toEvenInt(rect.width  / zoom);
      let cropH = u.toEvenInt(rect.height / zoom);
      if (cropW < 2) cropW = (rect.width  & ~1) || 2;
      if (cropH < 2) cropH = (rect.height & ~1) || 2;
      // center inside rect (even-aligned)
      let x = rect.x + ((rect.width  - cropW) >> 1);
      let y = rect.y + ((rect.height - cropH) >> 1);
      x &= ~1; y &= ~1;
      return new VideoFrame(frame, { visibleRect: { x, y, width: cropW, height: cropH } });
    }

    async function initRTC() {
      const log = msg => $('#state') && ($('#state').textContent = String(msg));
      log('Connecting…');

      let ctrl;
      try {
        ctrl = await RTC.startB({
          log,
          onOpen: (ch) => {
            dc = ch;
            log('connected');
          },
          onMessage: (data) => {
            const bit = Number.parseInt(data, 10);
            if (!Number.isNaN(bit)) Controller.handleBit(bit);
          }
        });
      } catch (err) {
        log('ERR: ' + (err && (err.stack || err)));
        return false;
      }
      if (!ctrl?.pc) { log('no offer found — open A first'); return false; }
      return true;
    }

    async function init() {
      if (!window.Config) return false;
      Config = window.Config;
      cfg = Config.get();

      // Request resolution comes from config (single source of truth).
      const reqW = Number(cfg.camW) || 0;
      const reqH = Number(cfg.camH) || 0;

      if (cfg.url || cfg.topMode !== undefined) {
        if (cfg.topMode === 1) {
          videoTop = new Image();
          videoTop.crossOrigin = 'anonymous';
          videoTop.src = cfg.url;
          try {
            await videoTop.decode();
          } catch (err) {
            if ($('#urlWarn')) $('#urlWarn').textContent = '⚠️';
            console.log('Failed to load top camera feed', err);
            return false;
          }
        } else {
          if (!await initRTC()) return false;
        }
      }

      if (!navigator.mediaDevices?.getUserMedia) {
        console.log('getUserMedia not supported');
        return false;
      }
      let frontStream;
      try {
        frontStream = await navigator.mediaDevices.getUserMedia({
          audio: false,
          video: {
            width: { ideal: reqW },
            height: { ideal: reqH },
            facingMode: 'environment',
            frameRate: { ideal: 60 }
          }
        });
      } catch (err) {
        console.log('Front camera init failed', err);
        return false;
      }

        track = frontStream.getVideoTracks()[0];
        // Do NOT overwrite config with measured track settings; config drives the camera.
        const workerTrack = track.clone();
        videoWorker = startVideoWorker(workerTrack, (frame) => {
          let cropped;
          try {
            cropped = zoomFrame(frame);
            if (lastFrame) lastFrame.close();
            lastFrame = cropped;
          } finally {
            frame.close();
          }
        });

      const cap = track.getCapabilities();
      const {
        powerEfficient,
        exposureMode,
        exposureTime,
        iso,
        focusMode,
        focusDistance,
        whiteBalanceMode,
        colorTemperature,
      } = cap;
      const advConstraints = [];

      if (powerEfficient) advConstraints.push({ powerEfficient: false });

      if (exposureMode?.includes('manual') && exposureTime && iso) {
        advConstraints.push({
          exposureMode: 'manual',
          exposureTime: 1 / 500,
          iso: 400,
        });
      }
      if (focusMode?.includes('manual') && focusDistance) {
        advConstraints.push({ focusMode: 'manual', focusDistance: 3.0 });
      }
      if (whiteBalanceMode?.includes('manual') && colorTemperature) {
        advConstraints.push({
          whiteBalanceMode: 'manual',
          colorTemperature: 5600,
        });
      }
      if (advConstraints.length) {
        try {
          await new Promise(r => setTimeout(r, 1500));
          await track.applyConstraints({ advanced: advConstraints });
        } catch (err) {
          console.log('Advanced constraints apply failed:', err);
        }
      }
      return true;
    }

    return {
      init,
      top: () => videoTop,
      frontFrame: () => {
        const frame = lastFrame;
        lastFrame = null;
        return frame;
      }
    };
  })();

  window.Feeds = Feeds;
})();
