(function () {
  'use strict';

  const TOP_MODE_MJPEG = 'mjpeg';
  const TOP_MODE_WEBRTC = 'webrtc';

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
    let cfg;
    let videoTop, track, dc, videoWorker;
    let lastFrame, cropRatio = 1;
    let desiredW, desiredH;

    async function initRTC() {
      const stateEl = $('#state');
      const log = msg => stateEl && (stateEl.textContent = msg);
      log('Connecting…');

      let ctrl;
      try {
        ctrl = await StartB({ log });
      } catch (err) {
        log('ERR: ' + (err && (err.stack || err)));
        return false;
      }

      const pc = ctrl?.pc;
      if (!pc) { log('no offer found — open A first'); return false; }

      pc.ondatachannel = ({ channel }) => {
        dc = channel;
        log('connected');
        dc.onmessage = ({ data }) => {
          const bit = Number.parseInt(data, 10);
          if (!Number.isNaN(bit)) Controller.handleBit(bit);
        };
      };

      window.sendBit = bit => { if (dc?.readyState === 'open') dc.send(bit); };
      return true;
    }

    async function init() {
      cfg = window.Config?.get?.() || {};
      const reqResW = cfg.frontResW ?? cfg.topResW;
      const reqResH = cfg.frontResH ?? cfg.topResH;
      desiredW = reqResW;
      desiredH = reqResH;

      if (cfg.url || cfg.topMode) {
        const mode = cfg.topMode ?? TOP_MODE_WEBRTC;
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
        const { width: w = reqResW, height: h = reqResH } = track.getSettings();
        // Default to full-frame if requested size is missing
        desiredW = desiredW || w;
        desiredH = desiredH || h;
        cropRatio = Math.max(w / desiredW, h / desiredH);
        const workerTrack = track.clone();
        videoWorker = startVideoWorker(workerTrack, (frame) => {
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
          const midX = Math.max(0, (frameW - cropW) >> 1);
          const midY = Math.max(0, (frameH - cropH) >> 1);
          const ox = (baseRect.x + midX) & ~1;
          const oy = (baseRect.y + midY) & ~1;
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
