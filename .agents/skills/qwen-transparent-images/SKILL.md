---
name: qwen-transparent-images
description: Use when generating or verifying transparent Qwen Image 2.1 overlays, cutouts, stickers, or sprites in Easel.
---

# Qwen Transparent Images

Apply this guidance when the user requests a transparent background, cutout,
sticker, sprite, or image overlay using `qwen-image-2.1`.

## Generate or edit

Use the exact enabled Qwen ID from `list_models`. The actual image-tool prompt
MUST start and end with these exact sentences:

> This is an RGBA image with transparency. <foreground description>. The image has alpha channel and the background is transparent.

Between them, describe the foreground, composition, style, and transparent
margins in declarative prose. Preserve requested text character for character
in straight double quotes. Keep the background transparent throughout the
description. A solid title panel or drawn checkerboard changes the requested
asset. Respect the user's generation limit. After acceptance, end the turn and
let the host finish the job; never poll or resubmit it.

## Verify the original PNG

After the host's completion notification, inspect the saved image visually AND
verify its alpha numerically before your final assessment. A white or purple
fill in a visual observation does not prove that the PNG background is opaque.

When `execute_canvas_javascript` is available, you MUST use it to decode the
attached original PNG with a detached canvas and inspect the alpha bytes.
This is a read-only probe: do not append the canvas to the DOM, alter visible
content, save source, reload, or edit a timeline. A user's request to leave the
canvas/timeline unchanged allows this read-only operation. Substitute the
actual saved asset ID into this example:

```javascript
await EaselCanvas.whenReady();
await EaselCanvas.assets.ready;
const image = new Image();
image.src = await EaselCanvas.assets.getUrl('ASSET_ID_FROM_COMPLETION');
await image.decode();
const canvas = document.createElement('canvas');
canvas.width = image.naturalWidth;
canvas.height = image.naturalHeight;
const context = canvas.getContext('2d');
context.drawImage(image, 0, 0);
const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
let minAlpha = 255, maxAlpha = 0, zeroPixels = 0, nearZeroPixels = 0;
let bandMin = 255, bandMax = 0, bandSum = 0, bandPixels = 0;
const bandHeight = Math.max(1, Math.floor(canvas.height * 0.05));
for (let i = 3; i < pixels.length; i += 4) {
  const a = pixels[i];
  minAlpha = Math.min(minAlpha, a);
  maxAlpha = Math.max(maxAlpha, a);
  zeroPixels += a === 0;
  nearZeroPixels += a <= 10;
  const y = Math.floor((i - 3) / 4 / canvas.width);
  if (y < bandHeight || y >= canvas.height - bandHeight) {
    bandMin = Math.min(bandMin, a);
    bandMax = Math.max(bandMax, a);
    bandSum += a;
    bandPixels++;
  }
}
return { width: canvas.width, height: canvas.height, minAlpha, maxAlpha,
  totalPixels: pixels.length / 4, zeroPixels, nearZeroPixels,
  topBottom5PercentBands: { minAlpha: bandMin, maxAlpha: bandMax,
    meanAlpha: bandSum / bandPixels, pixels: bandPixels },
  cornerAlpha: [pixels[3], pixels[canvas.width * 4 - 1],
    pixels[(canvas.height - 1) * canvas.width * 4 + 3], pixels[pixels.length - 1]] };
```

Report only measurements you actually obtained. Foreground letters or icon
pads are expected to be opaque; nonzero whole-image pixels do not establish an
opaque background. Use band statistics as background evidence only when visual
inspection confirms the bands contain empty margins, not the subject. RGBA
format alone is not proof of a transparent background. Distinguish usable transparency from exact zero
alpha throughout the background; Qwen can leave near-zero residue. If the
probe fails or the tool is unavailable, state the limitation and specific
error. A visual uncertainty alone does not justify another billed generation
or reference edit. Never promise exact transparency from the prompt alone.

Official guidance: https://github.com/QwenLM/Qwen-Image-2.1#transparent-image-generation-rgba
