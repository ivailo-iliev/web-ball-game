(function () {
  'use strict';
  const panes = new Map();
  const number = (value, digits = 1) => Number.isFinite(value) ? value.toFixed(digits) : '—';
  const formatStats = s => {
    if (!s.connected) return 'Waiting for WebRTC connection…';
    return [
      `Capture ${number(s.captureFps)} fps | Sent ${number(s.sentFps)} fps | Received ${number(s.receivedFps)} fps | Displayed ${number(s.displayedFps)} fps`,
      `Video bitrate ${number(s.bitrateMbps, 2)} Mbps | RTT ${number(s.rttMs)} ms | Packet loss ${number(s.packetLossPercent, 2)}%`,
      `Phone copy ${number(s.copyMs)} ms/frame | Top game detection ${number(s.gameplayFps)} fps${s.dimensions ? ` | ${s.dimensions}` : ''}`
    ].join('\n');
  };
  window.addEventListener('message', event => {
    const data = event.data;
    const active = panes.get(data?.source);
    if (event.origin !== location.origin || !active || event.source !== active.pane.contentWindow) return;
    if (data.type === 'calibration-perf-ready') {
      active.pane.contentWindow.postMessage({
        type: 'calibration-perf-rate', source: data.source, fps: Number(active.select.value)
      }, location.origin);
    } else if (data.type === 'calibration-perf-stats') {
      active.metrics.textContent = formatStats(data.stats);
    } else if (data.type === 'calibration-perf-error') {
      active.metrics.textContent = 'WebRTC stats unavailable: ' + data.message;
    }
  });
  for (const source of ['top', 'front']) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = source === 'top' ? 'Top phone' : 'Front / index phone';
    const url = new URL(source === 'top' ? 'top.html' : 'index.html', location.href);
    url.search = '';
    const input = document.createElement('input');
    input.readOnly = true;
    input.value = url.href;
    input.setAttribute('aria-label', title.textContent + ' join URL');
    input.onclick = () => input.select();
    const copy = document.createElement('button');
    copy.textContent = 'Copy join URL';
    copy.onclick = async () => {
      try { await navigator.clipboard.writeText(url.href); copy.textContent = 'Copied'; }
      catch { input.select(); copy.textContent = 'Select and copy URL'; }
    };
    const control = document.createElement('label');
    control.className = 'rate-control';
    control.textContent = 'Calibration video rate: ';
    const select = document.createElement('select');
    select.setAttribute('aria-label', title.textContent + ' calibration FPS');
    for (const fps of [2, 5, 10, 15, 30]) {
      const option = document.createElement('option');
      option.value = String(fps);
      option.textContent = fps + ' FPS';
      select.append(option);
    }
    control.append(select);
    const metrics = document.createElement('pre');
    metrics.className = 'perf-metrics';
    metrics.textContent = 'Waiting for WebRTC connection…';
    const pane = document.createElement('iframe');
    pane.title = title.textContent + ' configuration and detector preview';
    pane.src = 'calibration-pane.html?' + new URLSearchParams({ source });
    panes.set(source, { pane, select, metrics });
    select.addEventListener('change', () => {
      pane.contentWindow?.postMessage({
        type: 'calibration-perf-rate', source, fps: Number(select.value)
      }, location.origin);
    });
    section.append(title, input, copy, control, metrics, pane);
    document.getElementById('panes').append(section);
  }
})();
