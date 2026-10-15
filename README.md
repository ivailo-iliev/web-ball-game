# Fixed-room WebRTC signaling on Netlify (A/B)

Workflow:
1) Open `top.html` (Peer A). It resets gameplay and publishes an offer.
2) Open `index.html` (Peer B) and press **Connect Game** to join without resetting.
3) To reconnect manually: **Reset Game** on top, then **Connect Game** on index.
Trickle ICE candidates are exchanged during negotiation. After the data channel opens, there are no more signaling requests.

Uses Netlify Functions + Netlify Blobs (strong consistency) as a tiny signaling mailbox.

## Remote calibration

1. On the workstation open `calibrate.html` on the same site. This resets and offers
   both calibration rooms. No session ID or
   join token is needed. Signaling is not authenticated: the three rooms are
   shared by all visitors, so use one workstation and one phone per role at a time.
2. Copy the displayed normal `top.html` and `index.html` URLs to their respective
   phones and press **Connect Cal** on each, after opening the workstation page.
   To reconnect, press **Reset** on the corresponding workstation pane and then
   **Connect Cal** on its phone. Press Start on the top phone to acquire its camera;
   the front phone acquires its
   camera as usual. The workstation acquires no camera.
3. Each pane displays the remote video and reuses its original configuration
   markup, configuration handlers and WebGPU detector/WGSL preview. Settings
   unlock when that phone's snapshot arrives. Changes persist through that
   phone's Config and update controls/cache without reloading. Camera resolution
   controls retain their existing behavior: acquisition constraints apply at
   camera startup, not mid-stream. Zoom/thresholds/ROI apply live.

The fixed pairings are `top.html` ↔ `index.html` in `default` (gameplay),
`calibrate.html` ↔ `top.html` in `calibration-top`, and `calibrate.html` ↔
`index.html` in `calibration-front`. The workstation panes select only `source=top`
or `source=front`; this is a role selector, not a session ID. Neither calibration
peer overwrites `RTC.send` or resets the gameplay room. Omitting `room` in the
signaling APIs still uses exactly `room/default`.

The same signal-read/write/reset endpoints are retained. Reset returns JSON
`{ generation }`, and reads include that room-local generation. Writes echo it;
stale or unversioned writes after reset return HTTP 409. Signals live beneath
`room/<room>/generations/<generation>/`, so even an old in-flight write cannot
be consumed by a new connection. Reset immediately switches only its own room; old-generation Blobs are cleaned
asynchronously when supported by Netlify. Generation IDs are internal signaling metadata, never join
tokens or URL parameters. Legacy unversioned rooms remain readable/writable until
their first reset.
Phone streaming draws independent clones of the existing cropped local frames
into a manually captured canvas. Each feed starts at 2 FPS; the workstation has
independent 2/5/10/15/30 FPS controls on `calibrate.html` that update each phone
through its calibration data channel, leaving camera constraints and gameplay
untouched. Background browser throttling and unavailable cameras can reduce the rate.
Phones look for the workstation offer after Connect Cal is pressed. Reconnection
requires a manual workstation reset and phone Connect Cal; successful links no
longer poll Netlify.

The pane's iframe is an isolated classic-script runtime with an in-memory
Config, so source settings cannot collide in workstation localStorage. It fetches
the authoritative top/index screen markup rather than duplicating controls,
detectors or shaders. No game scripts run inside the calibration panes, and no
settings are stored on Netlify. Configuration uses validated `calibration-state` and `calibration-config` messages.
Separate validated `calibration-rate` and `calibration-telemetry` messages control
streaming and report sender metrics. Panels show capture/sent/received/displayed
FPS, actual bitrate, RTT, packet loss, phone copy time and (for the top phone)
game detection FPS where supported by WebRTC statistics. The index detector runs
only on hit triggers.
Requires existing WebGPU/VideoFrame/track-processor support plus canvas manual
capture and WebRTC. Unsupported capture is logged without stopping gameplay.

## Checks

No test framework is required for the deterministic/static checks:

```sh
npm install --no-package-lock
npx tsc --noEmit
node tests/calibration-check.mjs
node tests/fixed-rooms-check.mjs
node tests/rtc-diagnostics-check.mjs
git diff --check
```

The focused fixed-room checks execute the actual signaling handlers with an
in-memory Blobs fixture and exercise RTC routing with a unit-test peer. They
verify all three reset/read/write namespaces, stale-generation rejection, phone
URL generation and normal/PWA-root bootstrap selection. They are not real WebRTC
or deployed Netlify evidence. The manual reset/connect lifecycle still needs physical-iPhone verification.

The three-peer E2E driver covers manual join/reconnect and shared fixed rooms.
Its local browser execution does not validate real iPhone network behavior. The driver uses Playwright only as a browser automation
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
## On-screen WebRTC negotiation diagnostics

Both phone pages display separate Game and Calibration timing panels, including
room reset, offer/answer exchange, ICE connected, data-channel open and cumulative
Netlify signaling request counts/durations. On `calibrate.html`, each source pane
shows the same timing information next to existing streaming FPS statistics.
All milestone times are measured locally from the start of that device's
connection attempt; they are not synchronized between devices. Netlify HTTP
totals are summed request durations and can overlap. Diagnostics remain visible
after success/failure; no additional signaling polling is required.
