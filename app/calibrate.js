(function () {
  'use strict';
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
    const pane = document.createElement('iframe');
    pane.title = title.textContent + ' configuration and detector preview';
    pane.src = 'calibration-pane.html?' + new URLSearchParams({ source });
    section.append(title, input, copy, pane);
    document.getElementById('panes').append(section);
  }
})();
