(function () {
  'use strict';


  function startVideoWorker(track, onFrame) {
    const workerSrc = `self.onmessage = async ({ data }) => {
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
    const worker = new Worker(workerURL);
    URL.revokeObjectURL(workerURL);
    worker.onmessage = ({ data }) => onFrame(data);
    try {
      worker.postMessage({ op: 'init-track', track }, [track]);
    } catch (e) {
      const processor = new MediaStreamTrackProcessor({ track });
      worker.postMessage({ op: 'init-stream', stream: processor.readable }, [processor.readable]);
    }
    return worker;
  }

  const Feeds = (() => {
    let Config, cfg;
    let videoTop, track, dc, videoWorker;
    let lastFrame, cropRatio = 1;
    let desiredW, desiredH;

    // Crop = Zoom (centered). ratio >= 1 crops to 1/ratio of current frame dimensions.
    function zoomFrame(frame, ratio) {
      const r = Math.max(1, Number(ratio) || 1);
      const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
      // compute crop size from current frame rect
      let cropW = toEvenInt(rect.width  / r);
      let cropH = toEvenInt(rect.height / r);
      if (cropW <= 0 || cropH <= 0) { cropW = rect.width & ~1; cropH = rect.height & ~1; }
      // center inside rect
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
        ctrl = await StartB({
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

      window.sendBit = bit => { if (dc?.readyState === 'open') dc.send(bit); };
      return true;
    }

    async function init() {
      Config = window.Config;
      cfg = Config.get();
      const { CAM_W, CAM_H, ASPECT } = cfg;
      desiredW = cfg.frontResW ?? cfg.topResW ?? CAM_W;
      desiredH = cfg.frontResH ?? cfg.topResH ?? toEvenInt(desiredW * ASPECT);
      const reqW = CAM_W;
      const reqH = CAM_H;

      if (cfg.url || cfg.topMode !== undefined) {
        if (isMjpeg()) {
          videoTop = new Image();
          videoTop.crossOrigin = 'anonymous';
          videoTop.src = cfg.url;
          try {
            await videoTop.decode();
          } catch (err) {
            $('#urlWarn')?.textContent = '⚠️';
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
        const { width: w = reqResW, height: h = reqResH } = track.getSettings();
        // Default to full-frame if requested size is missing
        desiredW = desiredW || w;
        desiredH = desiredH || h;
        cropRatio = Math.max(w / desiredW, h / desiredH);
        const workerTrack = track.clone();
        videoWorker = startVideoWorker(workerTrack, (frame) => {
          const rect = frame.visibleRect || { x: 0, y: 0, width: frame.codedWidth, height: frame.codedHeight };
          const frameW = rect.width;
          const frameH = rect.height;
          const targetW = desiredW || frameW;
          const targetH = desiredH || frameH;
          const rW = frameW / targetW;
          const rH = frameH / targetH;
          const r = Math.max(1, Math.max(rW, rH));
          cropRatio = r;
          let cropped;
          try {
            cropped = zoomFrame(frame, r);
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

    function setCrop(w, h) {
      desiredW = w;
      desiredH = h;
    }

    return {
      init,
      top: () => videoTop,
      frontFrame: async () => {
        const frame = lastFrame;
        lastFrame = null;
        return frame;
      },
      frontCropRatio: () => cropRatio,
      setCrop
    };
  })();

  window.Feeds = Feeds;
})();
