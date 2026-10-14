/* Each pane owns an isolated classic-script runtime: existing UI, Config and GPU. */
(async function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const source = params.get('source');
  const status = document.getElementById('connection');
  const report = text => { status.textContent = `${source}: ${text}`; };
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
      html, body { overflow: auto; height: auto; background: #111; color: white; margin: 0; }
      #connection { position: static; padding: .5rem; margin: 0; }
      #remoteFeed { display: block; width: 100%; height: 160px; object-fit: contain; }
      #previewRoot { position: relative; min-height: 400px; }
      #gfx, #gfx.rotate { position: static; transform: none; width: 100%; height: 300px; }
      #config, #cfg { position: static; width: auto; padding: .5rem; background: #222; }
      #configScreen { height: auto; display: flex; flex-direction: column; }
      #frontCam { width: 100%; height: 300px; }
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
    enableControls(false); // Include spinner buttons created by Setup.
    window.Calibration.link({
      source, offerer: true, report,
      onStream(stream) {
        video.srcObject = stream;
        void video.play().catch(err => report(err.message));
        if (source === 'top') void window.Controller.startDetection();
      },
      onState(state) { enableControls(state === 'ready'); }
    });
    window.addEventListener('pagehide', () => clearTimeout(window.CalibrationPreview.timer), { once: true });
  } catch (err) { report(err.message); }
})();
