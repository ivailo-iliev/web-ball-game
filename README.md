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

The optional browser smoke driver uses Playwright only as a browser automation
library (not a test framework or application dependency):

```sh
npm install --no-save --no-package-lock playwright
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
```

It executes real WebRTC, VideoFrames, canvas capture and the existing WebGPU
shader paths in headless Chromium with synthetic cameras and software Vulkan.
The test server runs the actual signal handlers against an explicit in-memory
Blobs fixture, and forces host-only ICE for the local test (no public STUN).
It checks both simultaneous streams, source-isolated persistence and two-way UI
updates, 2 FPS capture cadence, camera-request isolation, disconnect independence,
and the original no-query gameplay channel/local detector/launcher.

Physical phone cameras, mobile WebGPU compatibility, thermal/gameplay performance,
background tab behavior, real network/STUN connectivity and deployed Netlify Blobs
still need device/live validation. A passing synthetic smoke test does not prove
those. Netlify deploys from GitHub main: finish development and independent review
on the PR branch first; the reviewer owns merging and verifying the live deployment.
No preview deployment or production deployment is assumed by these local checks.