import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { AbandonAudioInputSchema, AudioTrackInputSchema, MusicInputSchema, SoundInputSchema, SpeechInputSchema,
  abandonAudioGeneration, downloadAudio, generateAudio, getAudioGenerationStatus, getAudioTrack, type AudioPayload, type MusicInput, type SpeechInput, type SoundInput } from './audio.js';
import type { ProviderOptions } from './media-http.js';
import { prepareOutputDirectory, saveMedia } from './output.js';

type Provider = (model?: string, mediaType?: 'image' | 'video' | 'audio') => ProviderOptions & { model?: string };
function result(payload: AudioPayload) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(payload) }], structuredContent: payload };
}
export function registerAudioTools(server: Pick<McpServer, 'registerTool'>, providerFor: Provider): void {
  for (const [kind, schema] of [['music', MusicInputSchema], ['speech', SpeechInputSchema], ['sound', SoundInputSchema]] as const) {
    server.registerTool('generate_' + kind, {
      description: `Submit Easel Suno ${kind} once. dryRun prepares the live browser without spending generation credits. Preserve attempt and track IDs; never retry an ambiguous POST. CAPTCHA requires manual noVNC resolution. Native sunoModel is separate from the API routing model.`,
      inputSchema: schema,
    }, async (input: MusicInput | SpeechInput | SoundInput, extra: { signal: AbortSignal }) => {
      const provider = providerFor(input.model || `suno-${kind}`, 'audio');
      const payload = await generateAudio(kind, { ...input, model: provider.model || `suno-${kind}` }, { ...provider, signal: extra.signal });
      return result({ ...payload, guidance: 'Preserve this receipt. Use get_audio_generation_status for the current shared-browser attempt, then captured track IDs with get_audio_track/download_audio. Do not resubmit or abandon automatically.' });
    });
  }
  server.registerTool('get_audio_generation_status', {
    description: 'Read the current shared Suno browser attempt. This is not a per-job queue; use captured track IDs after another attempt takes over. Never creates another generation.',
    inputSchema: z.object({ model: z.string().max(320).optional() }).strict(), annotations: { readOnlyHint: true },
  }, async (input, extra) => result(await getAudioGenerationStatus({ ...providerFor(input.model, 'audio'), signal: extra.signal })));
  server.registerTool('get_audio_track', {
    description: 'Inspect an existing Suno track using its exact captured UUID; never generates a replacement.',
    inputSchema: AudioTrackInputSchema, annotations: { readOnlyHint: true },
  }, async (input, extra) => result(await getAudioTrack(input.trackId, { ...providerFor(input.model, 'audio'), signal: extra.signal })));
  server.registerTool('abandon_audio_generation', {
    description: 'Explicitly abandon one exact unconfirmed Suno attempt ONLY after the human cancels a CAPTCHA or confirms a stuck attempt. Cannot cancel an accepted generation or refund credits.',
    inputSchema: AbandonAudioInputSchema, annotations: { destructiveHint: true },
  }, async (input, extra) => result(await abandonAudioGeneration(input.attemptId, { ...providerFor(input.model, 'audio'), signal: extra.signal })));
  server.registerTool('download_audio', {
    description: 'Decode/download an existing captured Suno track, preserving its actual served encoding. Set outputDirectory to the requesting workspace media/outbound directory to save a local file instead of returning a blob. Does not generate a new track.',
    inputSchema: AudioTrackInputSchema.extend({ outputDirectory: z.string().max(4096).optional() }).strict(),
  }, async (input, extra) => {
    if (input.outputDirectory) await prepareOutputDirectory(input.outputDirectory);
    const downloaded = await downloadAudio(input.trackId, { ...providerFor(input.model, 'audio'), signal: extra.signal });
    if (input.outputDirectory) return result({ track: downloaded.track, files: await saveMedia(input.outputDirectory, [downloaded.media]) });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ track: downloaded.track, extension: downloaded.media.extension }) },
      { type: 'resource' as const, resource: { uri: 'easel-media://audio/' + input.trackId, mimeType: downloaded.media.mimeType, blob: downloaded.media.data } }],
      structuredContent: { track: downloaded.track, mimeType: downloaded.media.mimeType, extension: downloaded.media.extension } };
  });
}
