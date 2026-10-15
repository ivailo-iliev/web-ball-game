(function () {
  'use strict';
  const panes = new Map();
  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const formatStats = s => {
    if (!s.connected) return 'Waiting for WebRTC connection…';
    return [
      `Capture ${number(s.captureFps)} fps | Sent ${number(s.sentFps)} fps | Received ${number(s.receivedFps)} fps | Displayed ${number(s.displayedFps)} fps`,
      `Video bitrate ${number(s.bitrateMbps, 2)} Mbps | RTT ${number(s.rttMs)} ms | Packet loss ${number(s.packetLossPercent, 2)}%`,
      `Phone copy ${number(s.copyMs)} ms/frame | Game detection ${Number.isFinite(s.gameplayFps) ? number(s.gameplayFps) + ' fps' : 'on hit triggers (index)'}${s.dimensions ? ` | ${s.dimensions}` : ''}`
    ].join('\n');
  };
  function renderPanel(active) {
    active.panel.textContent = [active.paneStatus, active.roomDiagnostics, active.perf]
      .filter(Boolean).join('\n\n');
  }
  window.addEventListener('message', event => {
    const data = event.data;
    const active = panes.get(data?.source);
    if (event.origin !== location.origin || !active || event.source !== active.pane.contentWindow) return;
    if (data.type === 'calibration-perf-ready') {
      active.pane.contentWindow.postMessage({
        type: 'calibration-perf-rate', source: data.source, fps: Number(active.select.value)
      }, location.origin);
    } else if (data.type === 'calibration-pane-status') {
      active.paneStatus = data.text;
      renderPanel(active);
    } else if (data.type === 'calibration-rtc-diagnostics') {
      active.roomDiagnostics = data.text;
      renderPanel(active);
    } else if (data.type === 'calibration-perf-stats') {
      active.perf = formatStats(data.stats);
      renderPanel(active);
    } else if (data.type === 'calibration-perf-error') {
      active.perf = 'WebRTC stats unavailable: ' + data.message;
      renderPanel(active);
    }
  });
  for (const source of ['top', 'front']) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = source === 'top' ? 'Top phone' : 'Front / index phone';

    const heading = document.createElement('header');
    heading.className = 'panel-head';
    const toolbar = document.createElement('div');
    toolbar.className = 'toolbar';
    const pane = document.createElement('iframe');
    pane.title = title.textContent + ' detector preview';
    pane.src = 'calibration-pane.html?' + new URLSearchParams({ source });

    const reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = '↻ Reset';
    reset.setAttribute('aria-label', 'Reset ' + title.textContent + ' calibration room');
    reset.addEventListener('click', () => {
      pane.contentWindow?.postMessage({ type: 'calibration-reset', source }, location.origin);
    });

    const select = document.createElement('select');
    select.className = 'rate-select';
    select.setAttribute('aria-label', title.textContent + ' calibration FPS');
    for (const fps of [2, 5, 10, 15, 30]) {
      const option = document.createElement('option');
      option.value = String(fps);
      option.textContent = fps + ' FPS';
      select.append(option);
    }
    toolbar.append(reset, select);
    heading.append(title, toolbar);

    const panel = document.createElement('pre');
    panel.className = 'perf-metrics';
    panel.setAttribute('aria-label', title.textContent + ' status and diagnostics');

    panes.set(source, {
      pane, select, panel,
      paneStatus: 'Waiting for calibration pane…',
      roomDiagnostics: 'Waiting for calibration signaling…',
      perf: 'Waiting for WebRTC connection…'
    });
    renderPanel(panes.get(source));
    select.addEventListener('change', () => {
      pane.contentWindow?.postMessage({
        type: 'calibration-perf-rate', source, fps: Number(select.value)
      }, location.origin);
    });
    section.append(heading, panel, pane);
    document.getElementById('panes').append(section);
  }
})();
