function installCanvasMediaRuntime() {
  function base64(bytes) {
    let binary = '';
    for (let start = 0; start < bytes.length; start += 8192) binary += String.fromCharCode(...bytes.subarray(start, start + 8192));
    return btoa(binary);
  }

  function photo(video, { maxWidth = 1280, name = 'Camera photo.png' } = {}) {
    if (!(video instanceof HTMLVideoElement) || !video.videoWidth || !video.videoHeight) throw new Error('Wait for the camera preview before taking a photo.');
    if (!Number.isInteger(maxWidth) || maxWidth < 160 || maxWidth > 1920) throw new Error('Photo width must be between 160 and 1920 pixels.');
    const canvas = document.createElement('canvas');
    const scale = Math.min(1, maxWidth / video.videoWidth);
    canvas.width = Math.round(video.videoWidth * scale);
    canvas.height = Math.round(video.videoHeight * scale);
    canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    return { type: 'image', mimeType: 'image/png', name, data: canvas.toDataURL('image/png').split(',')[1] };
  }

  async function recordAudio({ seconds = 10, name = 'Microphone recording.wav' } = {}) {
    if (typeof seconds !== 'number' || !Number.isFinite(seconds) || seconds < 1 || seconds > 30) throw new Error('Record between 1 and 30 seconds.');
    if (!navigator.mediaDevices?.getUserMedia) throw new Error('Microphone capture is unavailable in this browser.');
    let stream;
    let context;
    let source;
    let processor;
    let silent;
    try {
      context = new AudioContext();
      const resumed = context.resume();
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      let resumeTimeout;
      try {
        await Promise.race([resumed, new Promise((_, reject) => { resumeTimeout = setTimeout(() => reject(new Error('Click Record again to activate microphone audio.')), 5000); })]);
      } finally { clearTimeout(resumeTimeout); }
      if (context.state !== 'running') throw new Error('Click Record again to start the audio context.');
      source = context.createMediaStreamSource(stream);
      processor = context.createScriptProcessor(4096, 1, 1);
      silent = context.createGain();
      silent.gain.value = 0;
      const chunks = [];
      let length = 0;
      const limit = Math.ceil(seconds * context.sampleRate);
      const finished = new Promise((resolve, reject) => {
        processor.onaudioprocess = (event) => {
          if (stream.getAudioTracks().every((track) => track.readyState === 'ended')) {
            reject(new Error('Microphone capture was stopped.')); return;
          }
          const samples = event.inputBuffer.getChannelData(0).subarray(0, Math.max(0, limit - length));
          if (samples.length) { chunks.push(new Float32Array(samples)); length += samples.length; }
          if (length >= limit) resolve();
        };
        for (const track of stream.getAudioTracks()) track.addEventListener('ended', () => reject(new Error('Microphone capture stopped before recording finished.')), { once: true });
      });
      source.connect(processor);
      processor.connect(silent);
      silent.connect(context.destination);
      let timeout;
      try {
        await Promise.race([finished, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('No microphone audio arrived. Check the device and try again.')), (seconds + 10) * 1000); })]);
      } finally { clearTimeout(timeout); }
      const bytes = new Uint8Array(44 + length * 2);
      const view = new DataView(bytes.buffer);
      const writeText = (offset, text) => [...text].forEach((character, index) => view.setUint8(offset + index, character.charCodeAt(0)));
      writeText(0, 'RIFF'); view.setUint32(4, 36 + length * 2, true); writeText(8, 'WAVE');
      writeText(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
      view.setUint32(24, context.sampleRate, true); view.setUint32(28, context.sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
      writeText(36, 'data'); view.setUint32(40, length * 2, true);
      let offset = 44;
      for (const chunk of chunks) for (const value of chunk) { const sample = Math.max(-1, Math.min(1, value)); view.setInt16(offset, sample * (sample < 0 ? 32768 : 32767), true); offset += 2; }
      return { type: 'audio', mimeType: 'audio/wav', name, data: base64(bytes) };
    } finally {
      if (processor) processor.onaudioprocess = null;
      source?.disconnect(); processor?.disconnect(); silent?.disconnect();
      for (const track of stream?.getTracks() || []) track.stop();
      if (context && context.state !== 'closed') await context.close();
    }
  }

  async function share(media, { prompt = '' } = {}) {
    if (!window.EaselHost?.submitMedia) throw new Error('Sharing to chat is available inside Easel Studio.');
    return window.EaselHost.submitMedia({ media, prompt });
  }

  window.EaselMedia = Object.freeze({ photo, recordAudio, share });
}

module.exports = { installCanvasMediaRuntime };
