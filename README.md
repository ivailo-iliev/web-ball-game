# One-room WebRTC signaling on Netlify (A/B)

Workflow:
1) Open `top.html` first (Peer A). It resets the single room and posts the offer.
2) Then open `index.html` (Peer B). It reads the offer, posts the answer, and both peers exchange ICE candidates via polling.

Uses Netlify Functions + Netlify Blobs (strong consistency) as a tiny signaling mailbox.

## Remote calibration

1. On the workstation open `calibrate.html?calibration=<token>` on the same site.
   Tokens contain 1–64 letters, numbers, underscores or hyphens. The session form
   generates a token if none is supplied. Use a fresh, unpredictable token and
   keep its join URLs private: signaling is not an authenticated settings API.
2. Copy the displayed `top.html?calibration=<token>` and
   `index.html?calibration=<token>` URLs to their respective phones. Press Start
   on the top phone to acquire its existing camera; the front phone acquires its
   camera as usual. The workstation acquires no camera.
3. Each pane displays the remote video and reuses its original configuration
   markup, configuration handlers and WebGPU detector/WGSL preview. Settings
   unlock when that phone's snapshot arrives. Changes persist through that
   phone's Config and update controls/cache without reloading. Camera resolution
   controls retain their existing behavior: acquisition constraints apply at
   camera startup, not mid-stream. Zoom/thresholds/ROI apply live.

Two additional peers use `calibration-<token>-top` and
`calibration-<token>-front`. Neither overwrites `RTC.send` or resets the gameplay
room. Omitting `room` in the signaling APIs still uses exactly `room/default`.
Phone streaming draws independent clones of the existing cropped local frames
into a manually captured canvas, at most once every 500 ms (2 FPS), without
changing camera constraints or consuming gameplay's frame. Background browser
throttling and unavailable cameras can reduce the rate. Phones waiting for the
workstation poll for its offer. After a disconnected/reloaded phone or expired
session, reopen the workstation session and rejoin the phones to negotiate fresh
peers; reloading the workstation alone does not reconnect an already-connected
phone automatically.

The pane's iframe is an isolated classic-script runtime with an in-memory
Config, so source settings cannot collide in workstation localStorage. It fetches
the authoritative top/index screen markup rather than duplicating controls,
detectors or shaders. No game scripts run inside the calibration panes, and no
settings are stored on Netlify. Only the required `calibration-state` and
`calibration-config` JSON envelopes with allowlisted, validated values are used.
Requires existing WebGPU/VideoFrame/track-processor support plus canvas manual
capture and WebRTC. Unsupported capture is logged without stopping gameplay.

## Checks

No test framework is required for the deterministic/static checks:

```sh
npm install --no-package-lock
npx tsc --noEmit
node tests/calibration-check.mjs
git diff --check
```

The optional three-peer E2E driver uses Playwright only as a browser automation
library. Run from a disposable checkout/worktree on Linux/macOS/WSL with Node
supported by Netlify CLI and Chromium's system dependencies installed:

```sh
npm install --no-save --no-package-lock playwright@1.64.1 netlify-cli@27.12.1
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
```

The driver starts/stops `netlify dev --offline` itself, with the actual Functions
and local Blobs sandbox, and launches three independent Chromium instances.
It verifies simultaneous gameplay (0/1 receipt), both calibration UI patches and
per-phone localStorage persistence, wrong-phone isolation, independent calibration
disconnect/reconnect, and gameplay continuity without restarting its peer.
There is no custom signaling server, synthetic camera footage or detection test;
the existing production calibration canvas supplies only a minimal blank track.
Application RTC options (including STUN) are unchanged.

Do not run concurrently with another local game/Netlify session: the test resets
the local default gameplay room. Existing `.netlify` state is preserved; state
created by the driver is removed. Failure diagnostics identify peer/stage and
include local signaling/browser state. See [verification evidence and cleanup
checks](docs/calibration-verification.md) for limitations and failure injection.
A failing product assertion must not be skipped or fixed in application code just
to make this driver green.

Physical cameras, detector accuracy, mobile WebGPU, thermal/gameplay performance,
background throttling and deployed/network connectivity still need device/live
validation. Netlify deploys from GitHub main; independent review owns the merge
and deployment gate. These checks do not deploy or assume a preview deployment.