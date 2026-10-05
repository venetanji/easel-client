import {
  ALL_FORMATS,
  AudioBufferSink,
  AudioBufferSource,
  BlobSource,
  BufferTarget,
  CanvasSink,
  CanvasSource,
  Input,
  Output,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from '/mediabunny.mjs';

const frameRate = 24;
const sampleRate = 48_000;
const outputDuration = 0.75;
const sourceTrim = { start: 0.25, end: 0.75 };

function fail(message) {
  throw new Error(message);
}

async function sendResult(result) {
  await fetch('/result', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(result),
  });
}

function frameAt(frames, timestamp) {
  let selected = frames[0];
  for (const frame of frames) {
    if (frame.timestamp > timestamp + 1e-6) break;
    selected = frame;
  }
  return selected;
}

async function loadMedia(file) {
  const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
  const video = await input.getPrimaryVideoTrack();
  const audio = await input.getPrimaryAudioTrack();
  const frames = [];
  const audioBuffers = [];

  for await (const sample of new CanvasSink(video, {
    width: 96,
    height: 64,
    fit: 'fill',
    poolSize: 24,
  }).canvases()) {
    frames.push(sample);
  }
  for await (const sample of new AudioBufferSink(audio).buffers()) {
    audioBuffers.push(sample);
  }
  return { input, frames, audioBuffers };
}

function calculateRms(buffer, start, end) {
  const samples = buffer.getChannelData(0);
  const first = Math.max(0, Math.floor(start * buffer.sampleRate));
  const last = Math.min(samples.length, Math.floor(end * buffer.sampleRate));
  let energy = 0;
  for (let index = first; index < last; index += 1) energy += samples[index] ** 2;
  return Math.sqrt(energy / Math.max(1, last - first));
}

function mixTrimmedAudio(track, timelineStart, destination) {
  for (const { buffer, timestamp } of track.audioBuffers) {
    const start = Math.max(timestamp, sourceTrim.start);
    const end = Math.min(timestamp + buffer.duration, sourceTrim.end);
    if (end <= start) continue;

    const sourceStart = Math.floor((start - timestamp) * buffer.sampleRate);
    const sourceEnd = Math.floor((end - timestamp) * buffer.sampleRate);
    const destinationStart = Math.round((timelineStart + start - sourceTrim.start) * sampleRate);
    for (let channel = 0; channel < 2; channel += 1) {
      const source = buffer.getChannelData(Math.min(channel, buffer.numberOfChannels - 1));
      const output = destination.getChannelData(channel);
      for (let index = sourceStart; index < sourceEnd; index += 1) {
        const destinationIndex = destinationStart + index - sourceStart;
        if (destinationIndex < output.length) output[destinationIndex] += source[index] * 0.5;
      }
    }
  }
}

async function fetchFixture(path) {
  const response = await fetch(path);
  if (!response.ok) fail(`Fixture fetch failed: ${path} (${response.status})`);
  const name = path.split('/').at(-1);
  return new File([await response.arrayBuffer()], name, { type: 'video/mp4' });
}

async function probe() {
  const capabilities = {
    userAgent: navigator.userAgent,
    electron: globalThis.process?.versions?.electron || null,
    videoEncoder: typeof VideoEncoder,
    audioEncoder: typeof AudioEncoder,
    videoFrame: typeof VideoFrame,
    canEncodeAvc: await canEncodeVideo('avc', {
      width: 96, height: 64, frameRate, bitrate: 300_000,
    }),
    canEncodeAac: await canEncodeAudio('aac', {
      sampleRate, numberOfChannels: 2, bitrate: 96_000,
    }),
    canEncodeOpus: await canEncodeAudio('opus', {
      sampleRate, numberOfChannels: 2, bitrate: 96_000,
    }),
    canEncodeVp8: await canEncodeVideo('vp8', {
      width: 96, height: 64, frameRate, bitrate: 300_000,
    }),
  };
  const [clipA, clipB] = await Promise.all([
    fetchFixture('/fixtures/clip-a-12fps-red-440.mp4'),
    fetchFixture('/fixtures/clip-b-24fps-blue-660.mp4'),
  ]);
  const [mediaA, mediaB] = await Promise.all([loadMedia(clipA), loadMedia(clipB)]);
  if (mediaA.frames.length !== 12 || mediaB.frames.length !== 24) {
    fail(`Unexpected input frames A=${mediaA.frames.length}, B=${mediaB.frames.length}`);
  }

  const audioContext = new AudioContext({ sampleRate });
  const mixedAudio = audioContext.createBuffer(2, sampleRate * outputDuration, sampleRate);
  mixTrimmedAudio(mediaB, 0, mixedAudio);
  mixTrimmedAudio(mediaA, 0.25, mixedAudio);
  const audioRms = {
    bOnly: calculateRms(mixedAudio, 0.05, 0.2),
    overlap: calculateRms(mixedAudio, 0.32, 0.43),
    aOnly: calculateRms(mixedAudio, 0.56, 0.7),
  };
  if (Object.values(audioRms).some((value) => value < 0.01)) {
    fail(`Unexpected silent source mix: ${JSON.stringify(audioRms)}`);
  }

  const canvas = document.createElement('canvas');
  canvas.width = 96;
  canvas.height = 64;
  const context = canvas.getContext('2d', { alpha: false });
  const videoSource = new CanvasSource(canvas, {
    codec: 'vp8', bitrate: 300_000, keyFrameInterval: 0.5,
  });
  const audioSource = new AudioBufferSource({
    codec: 'opus', bitrate: 96_000, sampleRate, numberOfChannels: 2,
  });
  const target = new BufferTarget();
  const output = new Output({ format: new WebMOutputFormat(), target });
  output.addVideoTrack(videoSource);
  output.addAudioTrack(audioSource);
  await output.start();

  for (let index = 0; index < 18; index += 1) {
    const timestamp = index / frameRate;
    const frameB = frameAt(mediaB.frames, sourceTrim.start + timestamp);
    const frameA = timestamp >= 0.25
      ? frameAt(mediaA.frames, sourceTrim.start + timestamp - 0.25)
      : null;

    context.globalAlpha = 1;
    if (timestamp < 0.25) {
      context.drawImage(frameB.canvas, 0, 0, 96, 64);
    } else if (timestamp < 0.5) {
      context.drawImage(frameB.canvas, 0, 0, 96, 64);
      context.globalAlpha = (timestamp - 0.25) / 0.25;
      context.drawImage(frameA.canvas, 0, 0, 96, 64);
    } else {
      context.drawImage(frameA.canvas, 0, 0, 96, 64);
    }

    context.globalAlpha = 1;
    if (timestamp >= 0.25 && timestamp < 0.5) {
      context.fillStyle = 'rgba(255, 220, 0, 0.65)';
      context.fillRect(0, 0, 96, 18);
      context.fillStyle = '#111';
      context.font = 'bold 10px sans-serif';
      context.fillText('TITLE: MIX', 4, 12);
    }
    await videoSource.add(timestamp, 1 / frameRate);
  }
  await audioSource.add(mixedAudio);
  await output.finalize();

  const encoded = target.buffer;
  if (!encoded || encoded.byteLength < 1_000) fail('Renderer produced an empty output');
  const decoded = await loadMedia(new File([encoded], 'render.webm', { type: 'video/webm' }));
  if (decoded.frames.length !== 18) fail(`Unexpected output frames: ${decoded.frames.length}`);
  const samples = [0, 5, 6, 9, 11, 12, 17].map((index) => {
    const canvas = document.createElement('canvas');
    canvas.width = 96;
    canvas.height = 64;
    const context = canvas.getContext('2d', { willReadFrequently: true });
    context.drawImage(frameAt(decoded.frames, index / frameRate).canvas, 0, 0);
    const pixel = (x, y) => [...context.getImageData(x, y, 1, 1).data].slice(0, 3);
    return { frame: index, rgb: pixel(48, 40), titlePixel: pixel(3, 3) };
  });
  if (!(samples[0].rgb[2] > 150
    && samples[1].rgb[2] > 150
    && samples[5].rgb[0] > 150
    && samples[3].rgb[0] > 50
    && samples[3].rgb[2] > 50
    && samples[2].titlePixel[0] > 120
    && samples[2].titlePixel[1] > 120)) {
    fail(`Unexpected selected frame samples: ${JSON.stringify(samples)}`);
  }

  const cancelTarget = new BufferTarget();
  const cancelSource = new CanvasSource(canvas, { codec: 'vp8', bitrate: 300_000 });
  const cancelOutput = new Output({ format: new WebMOutputFormat(), target: cancelTarget });
  cancelOutput.addVideoTrack(cancelSource);
  await cancelOutput.start();
  await cancelSource.add(0, 1 / frameRate);
  await cancelOutput.cancel();
  let addAfterCancelRejected = false;
  try {
    await cancelSource.add(1 / frameRate, 1 / frameRate);
  } catch {
    addAfterCancelRejected = true;
  }

  const decodedAudio = decoded.audioBuffers;
  const result = {
    status: 'ok',
    cancellation: {
      partialTargetBytes: cancelTarget.buffer?.byteLength ?? 0,
      addAfterCancelRejected,
    },
    capabilities,
    sourceFrames: { a: mediaA.frames.length, b: mediaB.frames.length },
    audioRms,
    output: {
      byteLength: encoded.byteLength,
      frameCount: decoded.frames.length,
      firstTimestamp: decoded.frames[0].timestamp,
      lastTimestamp: decoded.frames.at(-1).timestamp,
      samples,
      audioBufferCount: decodedAudio.length,
      audioDuration: decodedAudio.reduce((duration, buffer) => Math.max(
        duration, buffer.timestamp + buffer.duration,
      ), 0),
      mime: await output.getMimeType(),
      bytesArray: Array.from(new Uint8Array(encoded)),
    },
  };
  mediaA.input.dispose();
  mediaB.input.dispose();
  decoded.input.dispose();
  await audioContext.close();
  return result;
}

try {
  await sendResult(await probe());
} catch (error) {
  console.error(error.stack || error);
  await sendResult({ status: 'error', error: String(error), stack: error.stack });
}
