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
export type AudioModelRoutes = Partial<Record<'music' | 'speech' | 'sound', string[]>>;

export function registerAudioTools(
  server: Pick<McpServer, 'registerTool'>,
  providerFor: Provider,
  configuredModels?: AudioModelRoutes,
): void {
  const utilityModelIds = configuredModels
    ? [...new Set(Object.values(configuredModels).flatMap((ids) => ids || []))]
    : undefined;
  if (configuredModels && !utilityModelIds?.length) return;

  const modelSchema = (ids?: string[]) => {
    if (!configuredModels) return z.string().max(320).optional();
    if (!ids?.length) throw new Error('Audio tool requires at least one configured model.');
    const choices = z.enum(ids as [string, ...string[]]).describe('Exact configured audio model ID from list_models.');
    return ids.length === 1 ? choices.default(ids[0]) : choices;
  };
  const audioProvider = (id?: string) => providerFor(id || (utilityModelIds?.length === 1 ? utilityModelIds[0] : undefined), 'audio');

  for (const [kind, schema] of [['music', MusicInputSchema], ['speech', SpeechInputSchema], ['sound', SoundInputSchema]] as const) {
    const ids = configuredModels?.[kind];
    if (configuredModels && !ids?.length) continue;
    const inputSchema = configuredModels ? schema.extend({ model: modelSchema(ids) }) : schema;
    server.registerTool('generate_' + kind, {
      description: `Submit Easel Suno ${kind} once. dryRun prepares the live browser without spending generation credits. Preserve attempt and track IDs; never retry an ambiguous POST. CAPTCHA requires manual noVNC resolution. Native sunoModel is separate from the API routing model.`,
      inputSchema,
    }, async (input: MusicInput | SpeechInput | SoundInput, extra: { signal: AbortSignal }) => {
      const routingModel = input.model || (ids?.length === 1 ? ids[0] : undefined) || `suno-${kind}`;
      const provider = providerFor(routingModel, 'audio');
      const payload = await generateAudio(kind, { ...input, model: provider.model || `suno-${kind}` }, { ...provider, signal: extra.signal });
      return result({ ...payload, guidance: 'Preserve this receipt. Use get_audio_generation_status for the current shared-browser attempt, then captured track IDs with get_audio_track/download_audio. Do not resubmit or abandon automatically.' });
    });
  }

  const utilityModel = modelSchema(utilityModelIds);
  server.registerTool('get_audio_generation_status', {
    description: 'Read the current shared Suno browser attempt. This is not a per-job queue; use captured track IDs after another attempt takes over. Never creates another generation.',
    inputSchema: z.object({ model: utilityModel }).strict(), annotations: { readOnlyHint: true },
  }, async (input, extra) => result(await getAudioGenerationStatus({ ...audioProvider(input.model), signal: extra.signal })));
  server.registerTool('get_audio_track', {
    description: 'Inspect an existing Suno track using its exact captured UUID; never generates a replacement.',
    inputSchema: AudioTrackInputSchema.extend({ model: utilityModel }), annotations: { readOnlyHint: true },
  }, async (input, extra) => result(await getAudioTrack(input.trackId, { ...audioProvider(input.model), signal: extra.signal })));
  server.registerTool('abandon_audio_generation', {
    description: 'Explicitly abandon one exact unconfirmed Suno attempt ONLY after the human cancels a CAPTCHA or confirms a stuck attempt. Cannot cancel an accepted generation or refund credits.',
    inputSchema: AbandonAudioInputSchema.extend({ model: utilityModel }), annotations: { destructiveHint: true },
  }, async (input, extra) => result(await abandonAudioGeneration(input.attemptId, { ...audioProvider(input.model), signal: extra.signal })));
  server.registerTool('download_audio', {
    description: 'Decode/download an existing captured Suno track, preserving its actual served encoding. Set outputDirectory to the requesting workspace media/outbound directory to save a local file instead of returning a blob. Does not generate a new track.',
    inputSchema: AudioTrackInputSchema.extend({ model: utilityModel, outputDirectory: z.string().max(4096).optional() }).strict(),
  }, async (input, extra) => {
    if (input.outputDirectory) await prepareOutputDirectory(input.outputDirectory);
    const downloaded = await downloadAudio(input.trackId, { ...audioProvider(input.model), signal: extra.signal });
    if (input.outputDirectory) return result({ track: downloaded.track, files: await saveMedia(input.outputDirectory, [downloaded.media]) });
    return { content: [{ type: 'text' as const, text: JSON.stringify({ track: downloaded.track, extension: downloaded.media.extension }) },
      { type: 'resource' as const, resource: { uri: 'easel-media://audio/' + input.trackId, mimeType: downloaded.media.mimeType, blob: downloaded.media.data } }],
      structuredContent: { track: downloaded.track, mimeType: downloaded.media.mimeType, extension: downloaded.media.extension } };
  });
}
