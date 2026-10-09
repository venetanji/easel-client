# Strudel M4A fixture

`snare.m4a` is the original procedural `sd` one-shot from
`assets/strudel-drums/bank.json`, encoded as AAC in an M4A container.
It contains no generated or user-owned media. Like the source drum bank,
it is distributed under the repository's GPL-3.0-or-later license.

To regenerate with FFmpeg:

```sh
node -e "require('node:fs').writeFileSync('/tmp/easel-snare.wav', Buffer.from(require('./assets/strudel-drums/bank.json').samples.find(s => s.name === 'sd').data, 'base64'))"
ffmpeg -hide_banner -loglevel error -i /tmp/easel-snare.wav \
  -map_metadata -1 -c:a aac -b:a 96k -fflags +bitexact -flags:a +bitexact \
  test/fixtures/strudel-samples/snare.m4a
```

Tests use the committed bytes and do not require FFmpeg. Native Electron
coverage matters here: Playwright's Chromium build does not decode AAC.
