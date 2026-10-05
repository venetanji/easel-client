# Synthetic video-export smoke fixtures

These tiny original fixtures contain only flat colors and generated tones, with no user media. They are committed so `npm run test:video-export` needs Electron and the built Mediabunny runtime, not FFmpeg or an external service. The smoke creates all output and browser data in a fresh temporary directory and verifies the fixture hashes stay unchanged.

Fixture generation used FFmpeg only during development:

```
ffmpeg -f lavfi -i color=c=red:s=96x64:r=12:d=1 -f lavfi -i sine=frequency=440:sample_rate=48000:duration=1 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac red.mp4
ffmpeg -f lavfi -i color=c=blue:s=96x64:r=24:d=1 -f lavfi -i sine=frequency=660:sample_rate=48000:duration=1 -shortest -c:v libx264 -pix_fmt yuv420p -c:a aac blue.mp4
ffmpeg -f lavfi -i sine=frequency=880:sample_rate=48000:duration=0.75 -c:a pcm_s16le tone.wav
ffmpeg -f lavfi -i color=c=yellow:s=96x32 -frames:v 1 overlay.png
```

The smoke reorders and trims the two videos, adds a still overlay and a separate audio layer with gain and fades, encodes WebM, decodes it and checks frame count/color boundaries/tone presence. It checks cancellation, malformed input, export after cancellation, and reports repeated output hashes. Byte-identical output is observed on the tested Linux runtime, not guaranteed across operating systems or encoders. WebM audio packet padding can make container duration slightly longer than the exact frame timeline.

On Linux, run in an existing desktop session or use `xvfb-run -a npm run test:video-export`. The durable smoke does not start a display server or network listener. The Electron renderer has no Node integration, device permissions or network access.
