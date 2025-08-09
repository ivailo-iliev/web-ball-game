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
let offerer  = null;
let answerer = null;

wss.on('connection', ws => {
  console.log('WS: new connection');

  // ------- relay hooks (install immediately) -------
  ws.on('message', (msg, isBinary) => {
    // always turn Buffers into strings before forwarding
    const data = isBinary ? msg.toString() : msg;
    console.log('WS ←', data);
    const target = ws === offerer ? answerer : offerer;
    if (target?.readyState === ws.OPEN) {
      console.log('WS → partner:', data);
      target.send(data);
    }
  });
  ws.on('close', () => {
    console.log('WS: connection closed');
    if (ws === offerer)  offerer  = null;
    if (ws === answerer) answerer = null;
  });

  if (!offerer) {            // first visitor: park and wait (will be the offerer)
    offerer = ws;
    return;                  // don't send the role yet ⇒ no early offer to lose
  }

  if (!answerer) {           // second visitor: complete the pair
    answerer = ws;

    // now both have partners — send the role messages
    offerer.send( JSON.stringify({ type:'role', role:'offerer' }));
    answerer.send(JSON.stringify({ type:'role', role:'answerer' }));
    return;
  }

  // more than two participants are not supported
  ws.close();
});
