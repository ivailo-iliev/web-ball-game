# Three-peer Netlify/WebRTC verification

Base: fetched `origin/main` at `0bf81b693b64a3a7c4ebfaeb2519684cd66ed4e5`.
Repository: `https://github.com/ivailo-iliev/web-ball-game.git`.
Only the integration driver, its resource helper, and documentation change.
Application scripts, Functions and lightweight tests are unchanged.

## Run

From a disposable checkout/worktree, with Node and Chromium's Linux/macOS/WSL
system dependencies installed (this run used Node 26.10.0):

```sh
npm install --no-save --no-package-lock playwright@1.64.1 netlify-cli@27.12.1
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" npx playwright install chromium
PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
node tests/calibration-check.mjs
npx tsc --noEmit
git diff --check
```

No Netlify account, deployment or production credentials are required. CLI offline
mode uses local Blobs; browser STUN options remain production defaults. The
optional install reported 16 high-severity dependency audit findings; no application
dependency/package manifest was changed as part of this test-only task.

Run exclusively: the production gameplay connection uses `room/default`, and the
driver resets that local room. Existing `.netlify` state is retained, but its test
room contents are not a backup of a running local game. State created when no
`.netlify` directory exists is removed on cleanup. A fresh worktree is recommended.

## What is exercised

- Three separate `chromium.launch()` processes, not three contexts in one browser:
  laptop `calibrate.html` (two independent pane runtimes), top `top.html`, front
  `index.html`. The actual `netlify dev` server serves the app and Functions.
- Real Functions/Blobs write/read/reset and room-isolation preflight, followed by
  production RTC signaling. Absolute Functions/static paths pin the tested
  worktree rather than Netlify's inferred main-checkout root.
- Production gameplay offer-first bootstrap: front's existing `startB` checks
  once, so front is opened only after top's gameplay offer exists. Calibration
  offers exist before the phones join. All three links are kept alive together.
- Top `RTC.send('0')` and `RTC.send('1')` arrive on front's native data channel.
  Existing message handlers are neither replaced nor bypassed. Tests observe
  received messages separately; they do not assert detection/game hit results.
- Each laptop pane changes its real `#teamA` select. Phone `cfg` and localStorage
  must agree; the other phone's entire Config snapshot/storage must stay unchanged.
- Each calibration pane is independently navigated away; only that phone's
  calibration controller is stopped. Gameplay and the other pane continue passing
  communication assertions. Reloading the removed pane publishes a new offer;
  the existing public `Calibration.link` API rejoins that phone with its original
  blank video track. This does not reload the phone or restart gameplay. Production
  has no single-calibration reconnect UI/automatic reconnect, so this API step is
  intentional, not a claim that automatic reconnect works.
- Distinct live gameplay/calibration peer objects and open laptop channels are
  checked initially, after each reconnect and finally. Exactly one gameplay start
  per phone is required, ruling out a hidden gameplay restart.

The only media adaptation is rejecting camera acquisition. The production
calibration phone already creates a 2×2 blank canvas track needed for its video
transceiver. No generated camera footage, media assertions, detector patches,
backend fixture, intercepted network responses, ICE/SDP modification or mocked
signaling are used. RTC wrappers observe calls/controllers without changing
options; a native peer subclass adds a message listener without changing handlers.

## Unmodified old-harness baseline (before editing)

Initial invocation failed with `ERR_MODULE_NOT_FOUND: Cannot find package
'playwright'`. After installing the optional dependencies and Chromium, the
untouched old `tests/calibration-browser-smoke.mjs` exited 0:

```text
PASS browser: top real WebRTC remote stream and seeded matching controls
PASS browser: front real WebRTC remote stream and seeded matching controls
PASS browser: independent control patches persist/apply on phones; phone edits refresh pane
PASS browser: top existing WebGPU detector successful (1 runs)
PASS browser: front existing WebGPU detector successful (1 runs)
NOT YET REVERIFIED after adjustable calibration FPS change: per-phone 2/5/10/15/30 FPS control and telemetry; camera acquisition stays unchanged and workstation has no camera
PASS browser: top disconnect does not stop front configuration transport
PASS browser: no-query pages retain default gameplay DC, local top detector and original launcher; no calibration initialization
PASS browser: no uncaught page errors, workstation camera acquisition forbidden
```

It also logged `no offer found — open A (top.html) first` from the
calibration-enabled front phone's gameplay startup. The old driver started that
phone before waiting for the gameplay offer, then tested gameplay later with a
separate no-query pair. Thus its green result did not establish simultaneous
three-link gameplay. It used synthetic cameras/custom in-memory Blobs and
host-only ICE; those mechanisms have been removed from this driver.

## Reproduced failures and their diagnosis

Early replacement runs, before pinning the Functions folder, failed at laptop↔
front/top state-snapshot readiness (90-second timeout), with data channels stuck
connecting and `setRemoteDescription` m-line order mismatch. A real Blobs isolation
probe then reproduced the same stored offer in gameplay, top and front rooms.
Inspection of `.netlify/functions-serve/signal-read/signal-read.mjs` showed compiled
`const base = "room/default"` with no `roomBase` import, despite the tested worktree
source containing room validation. Netlify had resolved relative Functions paths
from the stale main checkout (`a7eb87a`), not this current worktree. Absolute
`--functions` and `--dir` paths corrected the harness target; no application code
was changed. The isolation preflight remains an assertion to catch this again.

A separate cleanup-path run caught a harness init-script error on `about:blank`
(`navigator.mediaDevices` absent); guarding that unavailable API fixed the harness.
Neither failure is evidence of a current-`origin/main` product bug. Against the
correct, unchanged application, the local three-peer scenario passes; the reported
front-calibration defect was not reproduced under these conditions. Assertions
were not skipped or weakened to force a green result. A future product failure
must remain a nonzero result and be addressed in a separate application task.

## Cleanup and diagnostics

The resource helper owns the Netlify process group and all launched browsers.
`finally` cleanup applies to startup, partial browser acquisition, assertion and
success paths; SIGINT/SIGTERM use the same idempotent cleanup. Browsers are closed,
the Netlify group is terminated/escalated if necessary and its absence checked,
and newly acquired `.netlify` state is removed. Uncatchable SIGKILL/host failure
cannot be cleaned up by JavaScript. Pre-existing files are not recursively removed.

Failure output identifies connection/stage/assertion, page/frame UI, controller
ICE/signaling/channel state, localStorage, stored room SDP and recent server/browser
logs. Diagnostics contain local test SDP/addresses; inspect before sharing logs.

Fault injection (expected exit 1, not a passing product assertion):

```sh
E2E_FAIL_AT=startup  PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
E2E_FAIL_AT=browsers PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
E2E_FAIL_AT=assertion PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs
```

All three were executed and returned 1 with the cleanup confirmation. SIGTERM
was also sent after all three browsers were acquired: exit 143, cleanup confirmed,
and the newly created `.netlify` directory was absent afterward. The normal
invocation returned 0 and ended with `PASS three-peer Netlify/WebRTC E2E` and
`CLEANUP: all acquired browsers closed; Netlify process group terminated; owned local state removed`.
Lightweight checks returned all three PASS groups; `tsc --noEmit` and
`git diff --check` returned 0. No physical-camera/detection/mobile/deployed QA,
merge, self-approval or application bug fix is claimed.
