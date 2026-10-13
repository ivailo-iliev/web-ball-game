(function () {
  'use strict';
  const params = new URLSearchParams(location.search);
  const token = params.get('calibration');
  const form = document.getElementById('session');
  form.elements.calibration.value = token || crypto.randomUUID();
  if (token === null) return;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(token)) {
    document.getElementById('status').textContent = 'Invalid session: use 1–64 letters, numbers, underscores or hyphens.';
    return;
  }
  for (const source of ['top', 'front']) {
    const section = document.createElement('section');
    const title = document.createElement('h2');
    title.textContent = source === 'top' ? 'Top phone' : 'Front / index phone';
    const url = new URL(source === 'top' ? 'top.html' : 'index.html', location.href);
    url.search = new URLSearchParams({ calibration: token });
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
    const pane = document.createElement('iframe');
    pane.title = title.textContent + ' configuration and detector preview';
    pane.src = 'calibration-pane.html?' + new URLSearchParams({ calibration: token, source });
    section.append(title, input, copy, pane);
    document.getElementById('panes').append(section);
  }
})();
