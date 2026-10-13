# Remote calibration verification

Implementation base: `a7eb87ae834c1a3157a648f4f0fb0008aab1f2a2`.
Repository: `https://github.com/ivailo-iliev/web-ball-game.git`.

## Commands actually executed

- `npm install --no-package-lock`: passed; no vulnerabilities reported.
- Initial `npx tsc --noEmit`: failed because the baseline lacked Node type
  declarations required by Netlify's dependencies (`node:http`, `node:stream`,
  `NodeJS`). Added `@types/node` as a development dependency.
- Final `npx tsc --noEmit`: passed (exit 0, no diagnostics).
- `node tests/calibration-check.mjs`: passed (exit 0):
  - signaling default compatibility, isolated room read/reset, malformed JSON,
    invalid room and candidate-role rejection;
  - Config persistence/cache identity, isolated memory Config instances;
  - configuration key/value allowlist, bounds, required envelopes and malformed
    payload rejection;
  - all classic application scripts parse, all HTML script assets resolve and
    phone bootstrap order is correct.
- `git diff --check`: passed (exit 0, no output).
- Optional driver installation:
  `npm install --no-save --no-package-lock playwright` and
  `PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" npx playwright install chromium`:
  passed. Playwright is not an application dependency or test framework.
- `PLAYWRIGHT_BROWSERS_PATH="$PWD/node_modules/.cache/playwright" node tests/calibration-browser-smoke.mjs`:
  passed (exit 0), with the final output below.

## Final browser output

```text
PASS browser: top real WebRTC remote stream and seeded matching controls
PASS browser: front real WebRTC remote stream and seeded matching controls
PASS browser: independent control patches persist/apply on phones; phone edits refresh pane
PASS browser: top existing WebGPU detector successful (1 runs)
PASS browser: front existing WebGPU detector successful (1 runs)
PASS browser: independent canvas copies have <=2 FPS capture cadence; only one unchanged 60 FPS camera request per phone, none on workstation
PASS browser: top disconnect does not stop front configuration transport
PASS browser: no-query pages retain default gameplay DC, local top detector and original launcher; no calibration initialization
PASS browser: no uncaught page errors, workstation camera acquisition forbidden
```

The browser driver runs real peer connections/media/data channels and both
unchanged detector/WGSL paths. Cameras are Chromium synthetic devices at 320×240,
not physical phones. The actual Netlify handlers run against an explicit
in-memory Blobs fixture. Local ICE is host-only to avoid waiting for unreachable
public STUN. Software Vulkan is enabled for headless WebGPU.

Early smoke runs exposed an ordering bug (a later connected event disabled
already-seeded controls), fixed before the passing runs. Early default-ICE tests
waited for unavailable STUN; the local fixture now explicitly disables STUN.
An initial SwiftShader/ANGLE setup lost the GPU instance; switching the driver to
software Vulkan allowed both original WGSL paths to execute successfully. No
application GPU code or shader was replaced or modified to obtain those results.
The synthetic camera logs its existing advanced-constraints warning
(`focusDistance setting out of range`); the feed proceeds, with no uncaught page
errors. The original camera constraints remain unchanged.

## Review and deployment boundaries

- `top.html` and `index.html` each add only one shared calibration script tag.
- Configuration markup is fetched from the authoritative existing phone HTML
  into isolated iframes; detector, shader, and configuration implementations are
  reused, not duplicated. Pane settings use independent memory Config instances.
- All phone configuration updates go through Config.save and Setup.refresh.
- The original default gameplay room and RTC.send path are retained.
- No live Netlify deployment, physical-camera QA, merge or self-approval occurred.
- Physical phone/mobile WebGPU support, camera constraints/orientation on actual
  devices, gameplay/thermal performance with copying enabled, background browser
  throttling, public STUN/network connectivity and deployed Blobs isolation still
  need validation. The synthetic tests do not establish those results.
- Netlify deploys from GitHub main. Full development is handed to independent
  review on the PR branch. The reviewer owns the merge gate and subsequent live
  main deployment verification; no deploy preview is assumed.
