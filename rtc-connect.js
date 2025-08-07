// ---- 1. connect to signalling server on same host ----
const ws = new WebSocket('ws://p2p.local:8000');
ws.onopen = () => window.handleLog && handleLog('Waiting for peer…');
ws.onmessage = async e => {
  // if we accidentally got a binary frame, it'll arrive as a Blob
  let raw = e.data;
  if (raw instanceof Blob) {
    console.log('CLIENT: received Blob, converting to text');
    raw = await raw.text();
  }
  console.log('CLIENT ←', raw);
  handleSignal(JSON.parse(raw));
};

let dc; // DataChannel
const pc = new RTCPeerConnection({ iceServers: [] });
pc.onicecandidate = e => e.candidate && send({ type: 'cand', cand: e.candidate });

function send(obj) {
  ws.readyState === 1 && ws.send(JSON.stringify(obj));
}

// ---- 2. signalling handshake ----
async function handleSignal(m) {
  if (m.type === 'role') return start(m.role);
  if (m.type === 'offer') {
    await pc.setRemoteDescription(m.sdp);
    await pc.setLocalDescription(await pc.createAnswer());
    send({ type: 'answer', sdp: pc.localDescription });
  } else if (m.type === 'answer') await pc.setRemoteDescription(m.sdp);
  else if (m.type === 'cand') try {
    await pc.addIceCandidate(m.cand);
  } catch {}
}

function notifyOpen() {
  window.handleOpen && handleOpen();
}

async function start(role) {
  if (role === 'offerer') {
    dc = pc.createDataChannel('bit', { ordered: false, maxRetransmits: 0 });
    dc.onopen = notifyOpen;
    dc.onmessage = m => alert('Received: ' + m.data);
    await pc.setLocalDescription(await pc.createOffer());
    send({ type: 'offer', sdp: pc.localDescription });
  } else {
    pc.ondatachannel = e => {
      dc = e.channel;
      dc.onopen = notifyOpen;
      dc.onmessage = m => alert('Received: ' + m.data);
    };
  }
}

// ---- 3. send the single bit ----
function sendBit(bit) {
  dc?.readyState === 'open' && dc.send(bit);
}

window.sendBit = sendBit;

