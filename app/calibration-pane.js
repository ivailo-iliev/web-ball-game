/* Each pane owns an isolated classic-script runtime: existing UI, Config and GPU. */
(async function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const source = params.get('source');
  const status = document.getElementById('connection');
  const report = text => {
    const message = source + ': ' + text;
    if (status) status.textContent = message;
    if (window.parent !== window) window.parent.postMessage({ type: 'calibration-pane-status', source, text: message }, location.origin);
  };
  let desiredFps = 2, connection = null, latestSender = null;
  let previousInbound = null, statsBusy = false, renderFrames = 0;
  let renderWindow = performance.now(), displayedFps = null;
  const toParent = (type, values) => {
    if (window.parent !== window) window.parent.postMessage({ type, source, ...values }, location.origin);
  };
  window.addEventListener('message', event => {
    const data = event.data;
    if (event.origin !== location.origin || event.source !== window.parent || data?.source !== source) return;
    if (data.type === 'calibration-perf-rate' && [2, 5, 10, 15, 30].includes(data.fps)) {
      desiredFps = data.fps;
      connection?.setRate(desiredFps);
    } else if (data.type === 'calibration-reset') {
      const room = window.RTC?.rooms?.[source];
      if (room) void window.RTC.restart(room);
    }
  });
  const videoFrame = () => {
    if (!video.isConnected) return;
    renderFrames++;
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(videoFrame);
  };
  async function pollStats() {
    if (statsBusy) return;
    statsBusy = true;
    try {
      const now = performance.now();
      const duration = (now - renderWindow) / 1000;
      if (duration > 0) displayedFps = video.requestVideoFrameCallback ? renderFrames / duration : null;
      renderFrames = 0;
      renderWindow = now;
      const pc = window.RTC?.getController(window.RTC.rooms[source])?.pc;
      const active = pc?.connectionState === 'connected';
      if (!active) previousInbound = null;
      let receivedFps = null, bitrateMbps = null, packetLossPercent = null, rttMs = null;
      let dimensions = null;
      if (active) {
        const reports = await pc.getStats();
        const videoStats = Array.from(reports.values()).find(r =>
          r.type === 'inbound-rtp' && !r.isRemote && (r.kind === 'video' || r.mediaType === 'video'));
        if (videoStats) {
          if (videoStats.frameWidth && videoStats.frameHeight) dimensions = `${videoStats.frameWidth}×${videoStats.frameHeight}`;
          if (previousInbound && previousInbound.id === videoStats.id) {
            const seconds = (videoStats.timestamp - previousInbound.timestamp) / 1000;
            if (seconds > 0) {
              if (Number.isFinite(videoStats.framesDecoded) && Number.isFinite(previousInbound.framesDecoded)) {
                receivedFps = Math.max(0, (videoStats.framesDecoded - previousInbound.framesDecoded) / seconds);
              }
              if (Number.isFinite(videoStats.bytesReceived) && Number.isFinite(previousInbound.bytesReceived)) {
                bitrateMbps = Math.max(0, 8 * (videoStats.bytesReceived - previousInbound.bytesReceived) / (seconds * 1000000));
              }
              const lost = (videoStats.packetsLost ?? 0) - (previousInbound.packetsLost ?? 0);
              const received = (videoStats.packetsReceived ?? 0) - (previousInbound.packetsReceived ?? 0);
              if (lost >= 0 && received + lost > 0) packetLossPercent = lost * 100 / (lost + received);
            }
          }
          previousInbound = {
            id: videoStats.id, timestamp: videoStats.timestamp,
            bytesReceived: videoStats.bytesReceived, framesDecoded: videoStats.framesDecoded,
            packetsLost: videoStats.packetsLost, packetsReceived: videoStats.packetsReceived
          };
        } else previousInbound = null;
        const transport = Array.from(reports.values()).find(r => r.type === 'transport' && r.selectedCandidatePairId);
        const selected = transport ? reports.get(transport.selectedCandidatePairId)
          : Array.from(reports.values()).find(r => r.type === 'candidate-pair' && r.state === 'succeeded' && r.nominated);
        if (Number.isFinite(selected?.currentRoundTripTime)) rttMs = selected.currentRoundTripTime * 1000;
      }
      toParent('calibration-perf-stats', {
        stats: {
          connected: !!active, requestedFps: desiredFps,
          captureFps: latestSender?.captureFps ?? null,
          sentFps: latestSender?.sentFps ?? null,
          copyMs: latestSender?.copyMs ?? null,
          gameplayFps: latestSender?.gameplayFps ?? null,
          receivedFps, displayedFps: active ? displayedFps : null,
          bitrateMbps, packetLossPercent, rttMs, dimensions
        }
      });
    } catch (err) {
      toParent('calibration-perf-error', { message: err.message });
    } finally {
      statsBusy = false;
    }
  }
  if (!['top', 'front'].includes(source)) {
    report('Invalid calibration source'); return;
  }
  const video = document.createElement('video');
  video.autoplay = video.muted = video.playsInline = true;
  video.id = 'remoteFeed';
  window.CalibrationPreview = { video, report };
  try {
    // Import the authoritative markup, not another copy of the configuration screen.
    const response = await fetch(source === 'top' ? 'top.html' : 'index.html');
    if (!response.ok) throw new Error(`Screen fetch failed: ${response.status}`);
    const page = new DOMParser().parseFromString(await response.text(), 'text/html');
    for (const style of page.querySelectorAll('head style, head link[rel="stylesheet"]')) document.head.append(style.cloneNode(true));
    const root = document.createElement('div');
    root.id = 'previewRoot';
    if (source === 'top') root.append(page.getElementById('gfx'), page.getElementById('config'));
    else root.append(page.getElementById('configScreen'));
    document.body.append(video, root);
    // No game navigation or gameplay controls in the calibration-only runtime.
    for (const id of ['b0', 'start', 'btnStart', 'btnRefresh', 'btnViewCycle']) root.querySelector('#' + id)?.remove();
    const enableControls = ready => root.querySelectorAll('input, select, button').forEach(control => { control.disabled = !ready; });
    enableControls(false);
    const style = document.createElement('style');
    style.textContent = `
      html, body { overflow: hidden; width: 100%; height: 100%; background: #111; color: white; margin: 0; }
      #connection { display: none; }
      #remoteFeed { position: absolute; width: 1px; height: 1px; opacity: 0; pointer-events: none; }
      #previewRoot { position: relative; display: flex; flex-direction: column; width: 100%; height: 100%; min-height: 0; }
      #gfx, #gfx.rotate { position: static; flex: 1 1 auto; min-height: 180px; transform: none; width: 100%; height: auto; }
      #config, #cfg { position: static; flex: 0 0 auto; width: auto; padding: .5rem; background: #222; }
      #configScreen { flex: 1 1 auto; width: 100%; height: 100%; min-height: 0; display: flex; flex-direction: column; }
      #frontCam { flex: 1 1 auto; width: 100%; height: auto; min-height: 180px; }
      #cfg.hide-number-inputs .num-spinner, #cfg.hide-number-inputs label:has(input[type="number"]) { display: inline-flex; }
      #cfg label[for="frontZoom"] { display: inline-flex; }
      #state { display: none; }
    `;
    document.head.append(style);
    const load = src => new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = src; script.onload = resolve; script.onerror = () => reject(new Error(`Cannot load ${src}`));
      document.body.append(script);
    });
    for (const file of ['utils', 'webrtc', 'config', 'detect', 'feeds', 'setup', 'calibration', source === 'top' ? 'top' : 'app']) await load(`app/${file}.js`);
    window.RTC.subscribeDiagnostics(data => {
      if (data.room === window.RTC.rooms[source]) {
        toParent('calibration-rtc-diagnostics', { text: window.RTC.formatDiagnostics(data) });
      }
    });
    enableControls(false); // Include spinner buttons created by Setup.
    connection = window.Calibration.link({
      source, offerer: true, report,
      onOpen() { connection?.setRate(desiredFps); },
      onTelemetry(data) { latestSender = data; },
      onStream(stream) {
        video.srcObject = stream;
        void video.play().catch(err => report(err.message));
        if (source === 'top') void window.Controller.startDetection();
      },
      onState(state) { enableControls(state === 'ready'); }
    });
    if (typeof video.requestVideoFrameCallback === 'function') video.requestVideoFrameCallback(videoFrame);
    const perfTimer = setInterval(() => { void pollStats(); }, 2000);
    void pollStats();
    toParent('calibration-perf-ready', {});
    window.addEventListener('pagehide', () => {
      clearTimeout(perfTimer);
      clearTimeout(window.CalibrationPreview.timer);
    }, { once: true });
  } catch (err) { report(err.message); }
})();
