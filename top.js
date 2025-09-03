(function () {
  'use strict';

  const Controller = (() => {
    let dc;

    function handleOpen() {
      $('#state').textContent = 'Connected';
      $('#b0').disabled = false;
      $('#b0').onclick = () => sendBit('0');
    }

    function wireStartA() {
      const log = msg => $('#state') && ($('#state').textContent = String(msg));
      RTC.startA({
        log,
        onOpen: (ch) => {
          dc = ch;
          handleOpen();
        },
        onMessage: (data) => {
          console.log('msg:', data);
        }
      }).catch(err => {
        log('ERR: ' + (err && (err.stack || err)));
      });
    }

    function sendBit(bit) {
      if (dc && dc.readyState === 'open') {
        dc.send(bit);
        console.log(`[${new Date().toISOString()}] sent hit ${bit}`);
      }
    }

    function start() {
      Setup.bind();
      wireStartA();
    }

    return { start, sendBit };
  })();

  window.Top = { Controller };
  window.sendBit = Controller.sendBit;
  window.addEventListener('load', () => Controller.start());
})();
