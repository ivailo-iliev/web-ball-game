(function () {
  'use strict';

  // This script is loaded only by top.html. All readings are diagnostic;
  // they must not change camera constraints or the gameplay frame pipeline.
  const output = document.getElementById('camDiagnostics');
  if (!output) return;

  let cameraTrack = null;
  let requested = null;
  let frameRateCapability = null;
  let lastReport = performance.now();
  let incoming = 0;
  let processed = 0;
  let overwritten = 0;
  let gpuTotalMs = 0;
  let gpuMaxMs = 0;

  const number = (value, digits = 1) =>
    typeof value === 'number' && Number.isFinite(value) ? value.toFixed(digits) : '?';
  const dimension = value => Number.isFinite(value) ? value : '?';

  function onCameraStarted(track, constraints) {
    cameraTrack = track;
    requested = constraints;
    try {
      frameRateCapability = track.getCapabilities?.().frameRate || null;
    } catch (_) {
      frameRateCapability = null;
    }
    incoming = processed = overwritten = gpuTotalMs = gpuMaxMs = 0;
    lastReport = performance.now();
    output.textContent = 'Camera started; measuring frame rates…';
  }

  function onIncomingFrame(replacedPendingFrame) {
    incoming++;
    if (replacedPendingFrame) overwritten++;
  }

  function onProcessedFrame(durationMs) {
    processed++;
    gpuTotalMs += durationMs;
    gpuMaxMs = Math.max(gpuMaxMs, durationMs);
  }

  function render() {
    if (!cameraTrack) return;
    const now = performance.now();
    const elapsed = now - lastReport;
    if (elapsed < 500) return;

    let settings = {};
    try {
      settings = cameraTrack.getSettings?.() || {};
    } catch (_) { /* Safari may omit some camera settings. */ }

    const capability = frameRateCapability
      ? ` | track range ${number(frameRateCapability.min)}–${number(frameRateCapability.max)}`
      : '';
    const averageGpu = processed ? number(gpuTotalMs / processed) : '—';
    const maximumGpu = processed ? number(gpuMaxMs) : '—';

    output.textContent = [
      `Requested: ${dimension(requested.width)}×${dimension(requested.height)} @ ${requested.frameRate} fps (${requested.minFrameRate ? 'minimum' : 'ideal'})`,
      ...(requested.fallbackReason ? [`60 FPS minimum rejected: ${requested.fallbackReason}`] : []),
      `Camera: ${dimension(settings.width)}×${dimension(settings.height)} @ ${number(settings.frameRate)} fps${capability}`,
      `Delivered from worker: ${number(incoming * 1000 / elapsed)} fps | Processed: ${number(processed * 1000 / elapsed)} fps`,
      `Pending frames overwritten: ${overwritten} / ${incoming} | GPU.detect + readback: ${averageGpu} ms avg, ${maximumGpu} ms max`
    ].join('\n');

    incoming = processed = overwritten = gpuTotalMs = gpuMaxMs = 0;
    lastReport = now;
  }

  setInterval(render, 1000);
  window.TopDiagnostics = { onCameraStarted, onIncomingFrame, onProcessedFrame };
})();
