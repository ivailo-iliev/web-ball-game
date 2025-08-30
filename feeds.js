(function () {
  'use strict';

  const TOP_MODE_MJPEG = 'mjpeg';
  const TOP_MODE_WEBRTC = 'webrtc';

  function startVideoWorker(track, onFrame) {
    const workerSrc = `self.onmessage = async (e) => {
  const { op } = e.data || {};
  if (op === 'init-track') {
    const { track } = e.data;
    if (!track) return;
    const processor = new MediaStreamTrackProcessor({ track });
    const reader = processor.readable.getReader();
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      self.postMessage(frame, [frame]);
    }
  } else if (op === 'init-stream') {
    const { stream } = e.data;
    if (!stream) return;
    const reader = stream.getReader();
    for (;;) {
      const { value: frame, done } = await reader.read();
      if (done || !frame) break;
      self.postMessage(frame, [frame]);
    }
  }
};`;
    const workerURL = URL.createObjectURL(new Blob([workerSrc], { type: 'text/javascript' }));
    const worker = new Worker(workerURL);
    URL.revokeObjectURL(workerURL);
    worker.onmessage = (ev) => { onFrame(ev.data); };
    try {
      worker.postMessage({ op: 'init-track', track }, [track]);
    } catch (e) {
      const processor = new MediaStreamTrackProcessor({ track });
      worker.postMessage({ op: 'init-stream', stream: processor.readable }, [processor.readable]);
    }
    return worker;
  }

  const Feeds = (() => {
    const cfg = Config.get();
    let videoTop, track, dc, videoWorker;
    let lastFrame, cropRatio = 1;

    async function initRTC() {
      const stateEl = $('#state');
      const log = msg => { if (stateEl) stateEl.textContent = msg; };
      log('Connecting…');

      let ctrl;
      try {
        ctrl = await StartB({ log });
      } catch (err) {
        log('ERR: ' + (err && (err.stack || err)));
        return false;
      }

      const pc = ctrl && ctrl.pc;
      if (!pc) { log('no offer found — open A first'); return false; }

      pc.ondatachannel = e => {
        dc = e.channel;
        log('connected');
        dc.onmessage = ev => {
          const bit = parseInt(ev.data, 10);
          if (!isNaN(bit)) Controller.handleBit(bit);
        };
      };

      window.sendBit = bit => { if (dc && dc.readyState === 'open') dc.send(bit); };
      return true;
    }

    async function init() {
      const reqResW = cfg.frontResW ?? cfg.topResW;
      const reqResH = cfg.frontResH ?? cfg.topResH;

      if (cfg.url || cfg.topMode) {
        const mode = cfg.topMode || TOP_MODE_WEBRTC;
        if (mode === TOP_MODE_MJPEG) {
          const urlWarnEl = $('#urlWarn');
          videoTop = new Image();
          videoTop.crossOrigin = 'anonymous';
          videoTop.src = cfg.url;
          try {
            await videoTop.decode();
          } catch (err) {
            if (urlWarnEl) urlWarnEl.textContent = '⚠️';
            console.log('Failed to load top camera feed', err);
            return false;
          }
        } else if (mode === TOP_MODE_WEBRTC) {
          if (!await initRTC()) return false;
        } else {
          console.log('Unknown topMode', mode);
          return false;
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
            width: { ideal: reqResW },
            height: { ideal: reqResH },
            facingMode: 'environment',
            frameRate: { ideal: 60 }
          }
        });
      } catch (err) {
        console.log('Front camera init failed', err);
        return false;
      }

      track = frontStream.getVideoTracks()[0];
      const settings = track.getSettings();
      const w = settings.width || reqResW;
      const h = settings.height || reqResH;
      cropRatio = Math.max(w / (cfg.frontResW ?? cfg.topResW), h / (cfg.frontResH ?? cfg.topResH));
      const workerTrack = track.clone();
      videoWorker = startVideoWorker(workerTrack, (frame) => {
        const desiredW = cfg.frontResW ?? cfg.topResW;
        const desiredH = cfg.frontResH ?? cfg.topResH;
        let cropW = desiredW;
        let cropH = desiredH;
        const baseRect = frame.visibleRect || {
          x: 0,
          y: 0,
          width: frame.codedWidth,
          height: frame.codedHeight
        };
        const frameW = baseRect.width;
        const frameH = baseRect.height;
        const aspect = desiredH / desiredW;
        if (cropW > frameW) {
          cropW = frameW;
          cropH = Math.round(cropW * aspect);
        }
        if (cropH > frameH) {
          cropH = frameH;
          cropW = Math.round(cropH / aspect);
        }
        cropW &= ~1;
        cropH &= ~1;
        cropRatio = Math.max(frameW / cropW, frameH / cropH);
        const ox = (baseRect.x + Math.max(0, (frameW - cropW) >> 1)) & ~1;
        const oy = (baseRect.y + Math.max(0, (frameH - cropH) >> 1)) & ~1;
        let cropped;
        try {
          cropped = new VideoFrame(frame, { visibleRect: { x: ox, y: oy, width: cropW, height: cropH } });
          if (lastFrame) lastFrame.close();
          lastFrame = cropped;
        } finally {
          frame.close();
        }
      });

      const cap = track.getCapabilities();
      const advConstraints = [];

      if (cap.powerEfficient) advConstraints.push({ powerEfficient: false });

      if (
        cap.exposureMode &&
        cap.exposureMode.includes('manual') &&
        cap.exposureTime &&
        cap.iso
      ) {
        advConstraints.push({
          exposureMode: 'manual',
          exposureTime: 1 / 500,
          iso: 400,
        });
      }
      if (
        cap.focusMode &&
        cap.focusMode.includes('manual') &&
        cap.focusDistance
      ) {
        advConstraints.push({ focusMode: 'manual', focusDistance: 3.0 });
      }
      if (
        cap.whiteBalanceMode &&
        cap.whiteBalanceMode.includes('manual') &&
        cap.colorTemperature
      ) {
        advConstraints.push({
          whiteBalanceMode: 'manual',
          colorTemperature: 5600,
        });
      }
      if (advConstraints.length) {
        try {
          await new Promise((r) => setTimeout(r, 1500));
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
        const f = lastFrame;
        lastFrame = null;
        return Promise.resolve(f);
      },
      frontCropRatio: () => cropRatio
    };
  })();

  window.Feeds = Feeds;
})();
