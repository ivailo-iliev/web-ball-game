# One-room WebRTC signaling on Netlify (A/B)

Workflow:
1) Open `top.html` first (Peer A). It resets the single room and posts the offer.
2) Then open `index.html` (Peer B). It reads the offer, posts the answer, and both peers exchange ICE candidates via polling.

Uses Netlify Functions + Netlify Blobs (strong consistency) as a tiny signaling mailbox.