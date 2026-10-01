# Harness release check

## Method

On 2026-10-01, use the embedded Codex backend with `gpt-6-luna`, a fresh chat,
a separate QA project, and the installed p5 kit. Submit requests through the
normal chat UI so tool discovery, durable jobs, completion notifications, and
automatic previews are exercised together. Use the same three requests before
and after the changes:

1. Generate one small square image using the configured Qwen media model: a
   tiny paper sailboat on calm teal water, with soft cream lighting. Use Easel
   media generation, not native image generation.
2. Make a 2-second camera push-in video from the sailboat image you just
   generated, using the configured LTX media model. Keep the water moving gently.
3. Create a small p5.js sketch: teal particles orbit on a cream background.
   Clicking emits a few particles. Add Pause and Reset controls, and make it
   resize with the viewer.

## Results

| Measurement | Before | After |
| --- | ---: | ---: |
| MCP calls for the three requests | 21 | 10 |
| Stored tool-result text, UTF-8 bytes | 156,275 | 47,746 |
| Empty `app.js` read, wrapped bytes | 4,133 | 989 |
| Initial source listing, wrapped bytes | 8,603 | 2,659 |
| Queued image receipt, wrapped bytes | 3,681 | 1,449 |
| First native developer message, characters | 26,920 | 19,754 |

These are observations from one run of each version, not a benchmark or a
guaranteed reduction in token charges. Stored tool-result sizes include the
text and structured MCP metadata saved in chat; they exclude binary image
observations. The native developer message also includes Codex's own environment
instructions. Cumulative native token usage counts context across model calls
and should not be reported as fresh input cost.

The updated run:

- Generated and previewed the image; completion was a short acknowledgment.
- Reused the known video model without another model listing. Omitting `size`
  succeeded on the first call; the endpoint produced a 1280x704 video lasting
  2.04 seconds. Its inline chat video loaded and played.
- Let the host monitor both jobs without agent polling or resubmission. Video
  completion resumed the originating chat after the active sketch turn ended.
- Created one registered p5 instance. Pausing froze rendered pixels, clicking
  added visible particles while paused, and Reset restored the running state.
- Fit the drawing canvas at 390x844 and 1100x700, with no app runtime errors.
  A 16-pixel desktop page overflow led to one follow-up layout repair.

That follow-up used exactly two MCP calls: one atomic patch with a state-preserving
reload, then one live capture. It reused source from the preceding turn without
another listing or read. Both tested viewports then fit without page overflow,
retaining one canvas and no app runtime errors.

The model still read starter files for the new sketch. The source-list tool and
p5 skill now distinguish existing edits from creation and point new sketches
directly to `present_canvas`.

## Smaller Model Observation

A manual Built-in run with `qwen-plus` requested rotating planets using p5 in
a project without the p5 kit. It created an empty document, then tried to
present another document at the same path. The collision response incorrectly
gave image-attachment advice. It subsequently wrote a CDN p5 script, which was
rejected with generic source-edit guidance. The model also claimed to enable
p5 without changing the kit selection. A later request ended with `terminated`;
that transport failure does not establish the model's task capability.

Creation receipts now report the actual enabled kits. Tool descriptions explain
that document creation inherits project kits and that a complete new sketch
can use `present_canvas` directly. Collision corrections distinguish creating
a new path from writing the existing document. Offline-reference corrections
explain removing CDN URLs and asking the user to enable the missing kit under
Project files > Canvas kits, then waiting for confirmation. Source edits now
preflight every HTML document before committing, so a rejected reference cannot
remain in a secondary canvas and block kit selection. New projects offer installed
kits as checkboxes; additional documents inherit their project's selection.
These follow-up changes have automated regression coverage;
the manual model run happened before they were applied.

A subsequent cube-texturing session ended three replies with an announced reload
or capture, without recording the corresponding tool call. The source patches
explicitly reported unchanged runtime. It also replaced a valid asset placeholder
with a relative path inside JavaScript, where local media paths are not rewritten.
The saved history confirms that those operations were not executed; it does not
retain the raw provider stream to distinguish model output from proxy conversion.
Instructions now require the next needed tool before a final reply and explicitly
limit local media paths to HTML/CSS. JavaScript uses the asset resolver or a returned
placeholder. These are instructions, not a guarantee that a weaker model follows them.

## Regression Coverage

Automated checks cover instruction length and backend-specific media routes,
compact source contracts, omitted media manifests, exact saved file revisions,
preservation of provider notes without nested job polling prose, and omitted
versus explicit video dimensions. Full diagnostics remain available through
`inspect_canvas`.

Keep release checks bounded: one coherent edit, one reload, and one live capture
with validation. Check actual interaction and viewport behavior separately;
an error-free renderer alone does not establish visual correctness.
