// $ npm  i  ws  bonjour
import { createServer } from 'http';
import { readFile }     from 'fs/promises';
import { join, extname } from 'path';
import { WebSocketServer } from 'ws';
import bonjour from 'bonjour';

const PORT       = 8000;            // HTTP + WS same port
const PUBLIC_DIR = '.';             // serve files from repo root
const MIME = {                       // very small mime table
  '.html':'text/html',
  '.js'  :'application/javascript',
  '.css' :'text/css',
  '.json':'application/json',
  '.png' :'image/png',
  '.wgsl' :'text/wgsl'
};

// ---------- tiny static-file web server ----------
const server = createServer(async (req, res) => {
  const file = req.url === '/' ? 'index.html' : req.url.slice(1);
  try {
    const data = await readFile(join(PUBLIC_DIR, file));
    res.writeHead(200, {'Content-Type': MIME[extname(file)] || 'application/octet-stream'});
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});
server.listen(PORT, () => console.log(`HTTP & WS on http://p2p.local:${PORT}`));

// ---------- mDNS / Bonjour advert ----------
bonjour().publish({ name: 'p2p', type: 'http', host:'p2p.local', port: PORT });
bonjour().publish({ name:'p2p-ws', type:'ws', host:'p2p.local', port:PORT });

// ---------- minimal signalling bridge ----------
const wss = new WebSocketServer({ server });   // share same port
let waiting = null;

wss.on('connection', ws => {
  // ------- relay hooks (install immediately) -------
  console.log('WS: new connection; waiting slot empty?', waiting === null);
  ws.on('message', (msg, isBinary) => {
    // always turn Buffers into strings before forwarding
    const data = isBinary ? msg.toString() : msg;
    console.log('WS ←', data);
    if (ws.partner?.readyState === ws.OPEN) {
      console.log('WS → partner:', data);
      ws.partner.send(data);
    }
  });
  ws.on('close', () => {
    console.log('WS: connection closed');
    if (waiting === ws) waiting = null;
  });

  if (!waiting) {            // first visitor: park and wait (will be the offerer)
    waiting  = ws;
    ws.role  = 'offerer';
    return;                  // don't send the role yet ⇒ no early offer to lose
  }

  // second visitor: complete the pair
  ws.role         = 'answerer';
  ws.partner      = waiting;
  waiting.partner = ws;

  // now both have partners — send the role messages
  ws.send(      JSON.stringify({ type:'role', role:'answerer' }));
  waiting.send( JSON.stringify({ type:'role', role:'offerer' }));

  waiting = null;            // reset for the next pair
});
