# Canvas kit candidates: p5.js and Strudel

Investigated on 2026-09-30 using the official npm packages and their included
source, README and license files. The canvas document stays offline; these kits
do not grant arbitrary network access.

| Candidate | Version inspected | License | Decision |
| --- | --- | --- | --- |
| p5.js | `p5@2.3.4` | LGPL-2.1 | Bundled as the optional `p5` kit |
| Strudel | `@strudel/web@1.3.0` | AGPL-3.0-or-later | Explored; not bundled or advertised as an available kit |

## p5.js: available offline

The build copies the unmodified official `lib/p5.min.js` into `canvas-kits/p5.js`.
It provides the classic `window.p5` constructor and does not need an ESM loader,
CDN or worker for ordinary 2D/WebGL sketches. The minified distribution skips
the remote friendly-error translation loading used by the development bundle.

The build also copies the upstream unminified library into
`canvas-kits/p5.source.js`; it is a source artifact, not a second loaded kit.
Both artifacts retain the full upstream LGPL-2.1 license and a link to the exact
upstream source version. Electron's existing `canvas-kits/*.js` packaging includes
both files. Release distributions and redistributed canvas exports must retain
the library notices and provide the LGPL library source/replacement rights.
Bundling p5 does not change Easel's ISC license to LGPL. The upstream source link
and packaged source artifact are useful for that distribution work; downstream
distributors should account for the complete LGPL terms.

### Authoring contract

- Select kit ID `p5`; use `new p5(sketch, mount)` in instance mode.
- This is p5 **2.x**. Load assets in an async `setup()` with `await`; p5 1.x's
  `preload()` lifecycle is no longer available. No compatibility addon is bundled.
- Register `instance.remove()` in the app's `EaselCanvas.registerApp` disposal
  hook. Use one instance per view and dispose it before replacing the view.
- 2D and WebGL2 rendering are available. The separately published WebGPU addon
  is not bundled.
- `p5.sound` is not included. Use the `tone` kit or native Web Audio for sound,
  with an explicit Start button to satisfy the browser's audio gesture rule.
- p5's camera/microphone helpers do not bypass Easel's capture permission flow.
  Use the host canvas media bridge where available; stop any returned stream
  tracks in disposal.
- `loadImage`, `loadFont`, `loadJSON` and related loaders use `fetch`, including
  for data/blob URLs. The canvas policy therefore needs local `data:`/`blob:`
  connection support. Use host-resolved project assets or embedded media;
  remote HTTP(S) URLs remain blocked.
- Browser download helpers are not a substitute for persistent project edits
  or the host's canvas export operation.

Example lifecycle:

```js
const mount = document.getElementById('app');
const state = { hue: 140 };
const sketch = new p5((p) => {
  p.setup = () => p.createCanvas(640, 360);
  p.draw = () => {
    p.background(244, 239, 222);
    p.fill(30, 95, 65);
    p.circle(p.width / 2, p.height / 2, 100);
  };
}, mount);

EaselCanvas.registerApp({
  id: 'sketch',
  root: mount,
  dispose: () => sketch.remove(),
  getState: () => ({ ...state }),
  restoreState: (saved) => Object.assign(state, saved),
});
```

### Inspection evidence

An isolated Chromium page loaded the generated bundle under Easel's canvas
content security policy and lifecycle bootstrap. Both a 2D sketch and a WebGL2
sketch rendered without page errors or runtime diagnostics errors. Managed
cleanup disposed the p5 instance, leaving zero DOM canvases and zero tracked
animation frames. No HTTP(S) requests occurred.

A data URL image failed with `connect-src 'none'` and loaded successfully with
`connect-src data: blob:`. This is why local fetch support is part of the kit's
contract. These observations are runtime inspections; no test suite was added.

## Strudel: promising, partial compatibility

The official browser bundle offers `strudel` and `initStrudel`; initialization
adds pattern functions such as `note`, `s` and `hush` to the global scope. It
registers synthesized sounds by default but does **not** download a sample
library by default. Sample collections are separate assets that must be
resolved locally, with their own licenses, rather than copied as GitHub/CDN
URLs from a Strudel REPL example.

The npm package and `superdough` audio engine are licensed under
**AGPL-3.0-or-later**, not MIT or plain GPL. Shipping their code as an integrated
Easel kit requires a deliberate decision about AGPL-compatible distribution,
corresponding source, and the scope of the combined work. An optional toggle
alone does not remove those obligations. No Strudel package or code was added
to Easel dependencies or shipped bundles during this exploration.

### Runtime observations

The official unmodified `@strudel/web` classic bundle was inspected in an
isolated Chromium page with the canvas content security policy:

- `initStrudel()` completed. A button-driven
  `note('c4 e4 g4').s('sine').play()` produced three queried pattern events and
  moved its native Web Audio context to `running`.
- Its default scheduler uses ordinary timers, so basic patterns do not require
  workers. The optional synchronized scheduler uses `SharedWorker` and a
  worker asset; the current canvas does not permit that mode.
- AudioWorklet registration failed in the inspected `about:blank` canvas
  origin because it did not expose `audioWorklet`. Worklet synths/effects are therefore
  not covered by the successful native oscillator observation. Merely allowing
  `worker-src blob:` would not fix an unavailable AudioWorklet API.
- A real button-driven `evaluate('note("c4").s("sine")')` failed with an
  `unsafe-eval` content security policy error. The REPL evaluator uses the
  JavaScript `Function` constructor. Direct native pattern calls avoid that
  evaluator, but they are a smaller contract than the full Strudel REPL.
- Audio still needs a user gesture. This inspection confirms initialization,
  pattern scheduling and audio context state; it does not claim an audible
  listening check or full compatibility with strudel.cc compositions.

The canvas media work is moving documents to a registered secure
`easel-canvas://document` origin. That can make the AudioWorklet API available,
but it does not grant execution of Strudel's embedded worklet URLs, synchronized
workers, or the dynamic REPL evaluator. Those paths need separate inspection
against the new origin and content security policy before being advertised.

### Recommendation

Keep Tone.js as the bundled audio kit for this release. Strudel merits a
separate integration with two explicitly supported paths:

1. A native pattern API with a bounded capability set, local samples, managed
   `hush()`/audio disposal and no dynamic string evaluator.
2. A full live coding environment with a suitable secure origin, locally
   bundled worklets/worker assets, an explicit evaluation policy and an
   AGPL-compatible release/source distribution plan.

Neither path should grant remote sample fetching automatically. Camera,
microphone and audio recording should share the canvas media permission and
asset persistence contract.

## Upstream references

- p5 source: https://github.com/processing/p5.js/tree/v2.3.4
- p5 package: https://www.npmjs.com/package/p5/v/2.3.4
- p5 asynchronous image loading: https://p5js.org/reference/p5/loadImage/
- Strudel source: https://codeberg.org/uzu/strudel
- Strudel web package: https://www.npmjs.com/package/@strudel/web/v/1.3.0
- Strudel sample documentation: https://strudel.cc/learn/samples/
