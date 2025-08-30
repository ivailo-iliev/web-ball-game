(function () {
  'use strict';

  const Controller = (() => {
    const state = $('#state');
    const b0 = $('#b0');
    let dc;

    function handleOpen() {
      state.textContent = 'Connected';
      b0.disabled = false;
      b0.onclick = () => sendBit('0');
    }

    function handleDcOpen() {
      state.textContent = 'dc: open';
      dc.send('hello from A');
      handleOpen();
    }

    function handleStartCtrl(ctrl) {
      dc = ctrl.channel;
      if (!dc) { state.textContent = 'No data channel'; return; }
      dc.onopen = handleDcOpen;
      dc.onmessage = e => console.log('msg:', e.data);
    }

    function sendBit(bit) {
      if (dc && dc.readyState === 'open') {
        dc.send(bit);
        console.log(`[${new Date().toISOString()}] sent hit ${bit}`);
      }
    }

    function start() {
      Setup.bind();
      StartA().then(handleStartCtrl).catch(err => {
        state.textContent = 'ERR: ' + (err && (err.stack || err));
      });
    }

    return { start, sendBit };
  })();

  window.Top = { Controller };
  window.sendBit = Controller.sendBit;
  window.addEventListener('load', () => Controller.start());
})();
