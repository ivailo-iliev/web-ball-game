// Minimal WebSocket signalling server
// $ npm i ws
// $ node server.js

import { WebSocketServer } from 'ws';
const wss = new WebSocketServer({ port: 8080 });

let waiting = null;                    // first client waiting for a partner

wss.on('connection', ws => {
  if (!waiting) {
    // no one waiting → mark this client as waiting
    waiting = ws;
    ws.role = 'offerer';
  } else {
    // pair established
    ws.partner = waiting;
    waiting.partner = ws;
    ws.role = 'answerer';
    waiting = null;
  }

  ws.send(JSON.stringify({type:'role',role:ws.role}));

  ws.on('message', data => {
    if (ws.partner && ws.partner.readyState === ws.partner.OPEN) {
      ws.partner.send(data);          // just forward any signalling msg
    }
  });

  ws.on('close', () => {
    if (ws.partner && ws.partner.readyState === ws.partner.OPEN) {
      ws.partner.close();
    }
    if (waiting === ws) waiting = null;
  });
});

console.log('Signalling server up on ws://<server-ip>:8080');
