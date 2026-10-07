import { z } from 'zod/v4';
import { headers, normalizeEaselBaseUrl, requestJson, requestSignal, type ProviderOptions } from './media-http.js';

export interface VideoDiscoveryInput { model: string; signal?: AbortSignal }
const identifier = z.string().max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/);
const shortText = z.string().max(2048);
const fraction = z.number().min(0).max(1);
const VideoCapabilitiesSchema = z.object({
  object: z.literal('video.capabilities'), schema_version: z.literal(1), model: z.string().min(1).max(256), fps: z.literal(24),
  seconds: z.object({ min: z.literal(1), max: z.literal(12), default: z.literal(4) }),
  sizes: z.array(z.string().regex(/^\d{2,5}x\d{2,5}$/)).min(1).max(32), default_size: z.string().regex(/^\d{2,5}x\d{2,5}$/),
  seed: z.object({ min: z.literal('0'), max: z.literal('18446744073709551614'), encoding: z.literal('decimal_string') }),
  loras: z.object({ max_count: z.literal(4), min_strength: z.literal(0), max_strength: z.literal(2), default_strength: z.literal(1), camera_default_strength: z.literal(0.8), catalog_path: z.literal('/v1/videos/loras') }),
  motion_speed: z.object({ min: z.literal(0.025), max: z.literal(1), requires_lora: z.literal('slow-motion') }),
  lora_reference_strength: z.object({ min: z.literal(0), max: z.literal(1), default: z.literal(1), requires_lora: z.literal('ingredients') }),
  uploads: z.object({ mime_types: z.array(z.enum(['image/png', 'image/jpeg', 'image/webp'])).min(1).max(3), max_total_bytes: z.literal(33554432) }),
  guiding_frames: z.object({ supported: z.boolean(), available: z.boolean(), validation: shortText, max_count: z.literal(8), frame_index_multiple: z.literal(1), min_strength: z.literal(0), max_strength: z.literal(1), default_strength: fraction,
    exclusive_with: z.array(z.enum(['input_reference', 'lora_reference', 'ingredients'])).min(3).max(3) }),
}).passthrough();
const H3CapabilitiesSchema = z.object({
  object: z.literal('video.capabilities'), schema_version: z.literal(1), model: z.literal('minimax-h3'), fps: z.literal(24),
  frames: z.object({ min: z.literal(124), max: z.literal(362), default: z.literal(124), step: z.literal(17), offset: z.literal(5) }),
  sizes: z.array(z.string().regex(/^\d{2,5}x\d{2,5}$/)).min(1).max(32), default_size: z.string(),
  seed: z.object({ min: z.literal('0'), max: z.literal('18446744073709551615'), encoding: z.literal('decimal_string') }),
  profiles: z.record(z.string(), z.object({ supported: z.boolean(), available: z.boolean(), validation: shortText, gpu_executed: z.boolean(), visually_reviewed: z.boolean() })),
  semantic_references: z.object({ max_count: z.literal(2), fields: z.array(z.string()) }),
  temporal_groups: z.object({ max_count: z.literal(3), image_counts: z.array(z.number().int()), fields: z.array(z.string()) }),
  uploads: z.object({ field: z.literal('images'), mime_types: z.array(z.enum(['image/png', 'image/jpeg'])), max_total_bytes: z.literal(33554432), max_total_pixels: z.number().int().positive(), max_image_pixels: z.number().int().positive(), max_count: z.literal(119) }),
  unsupported: z.array(shortText),
}).passthrough();
const VideoLoraSchema = z.object({
  id: identifier, kind: z.string().min(1).max(64), family: z.string().min(1).max(128),
  supported: z.boolean(), installed: z.boolean(), requires: z.array(z.string().min(1).max(128)).max(32),
  min_seconds: z.number().int().min(1).max(60).optional(),
  validation: shortText, tested_workflows: z.array(shortText).max(128).optional(),
  repo_id: shortText, revision: shortText, collection: shortText.optional(), gated: z.boolean().optional(), trigger: shortText.nullable().optional(),
  files: z.array(z.object({ filename: shortText, bytes: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER), sha256: z.string().regex(/^[a-f0-9]{64}$/) })).min(1).max(16),
});
export type VideoCapabilities = z.infer<typeof VideoCapabilitiesSchema> | z.infer<typeof H3CapabilitiesSchema>;
export type VideoLora = z.infer<typeof VideoLoraSchema>;

async function discover(options: VideoDiscoveryInput & ProviderOptions, path: string, label: string): Promise<unknown> {
  if (typeof options.model !== 'string' || !options.model.trim() || options.model.length > 256) throw new Error('Choose the exact video model before discovery.');
  const apiKey = options.apiKey || '';
  const query = options.model.trim() === 'minimax-h3' ? '?model=minimax-h3' : '';
  const payload = await requestJson(normalizeEaselBaseUrl(options.baseUrl) + path + query,
    { method: 'GET', headers: headers(apiKey), signal: requestSignal(options.signal, 30_000) }, apiKey, options.fetchImpl || globalThis.fetch,
    { label, path, model: options.model });
  const encoded = JSON.stringify(payload);
  if ([...new Set([apiKey, apiKey.trim()].filter(Boolean))].some(key => encoded?.includes(key) || encoded?.includes(JSON.stringify(key).slice(1, -1)))) {
    throw new Error('Credential found in discovery response; refusing to expose endpoint metadata.');
  }
  return payload;
}

export async function discoverVideoCapabilities(options: VideoDiscoveryInput & ProviderOptions): Promise<VideoCapabilities> {
  const schema = options.model.trim() === 'minimax-h3' ? H3CapabilitiesSchema : VideoCapabilitiesSchema;
  const parsed = schema.safeParse(await discover(options, '/v1/videos/capabilities', 'Video capability discovery'));
  if (!parsed.success) throw new Error('The endpoint returned an invalid or unsupported video capabilities contract. Support is unknown; do not infer capabilities from its model name.');
  if (parsed.data.model !== options.model.trim()) throw new Error('Video capability discovery returned a different model; do not apply these capabilities to the selected model.');
  if (!parsed.data.sizes.includes(parsed.data.default_size)) throw new Error('Video capabilities default size is not present in the size catalog.');
  return parsed.data;
}

export async function listVideoLoras(options: VideoDiscoveryInput & ProviderOptions): Promise<VideoLora[]> {
  const parsed = z.object({ object: z.literal('list'), data: z.array(VideoLoraSchema).max(256) }).safeParse(await discover(options, '/v1/videos/loras', 'Video LoRA discovery'));
  if (!parsed.success || new Set(parsed.data.data.map(lora => lora.id)).size !== parsed.data.data.length) throw new Error('The endpoint returned an invalid video LoRA catalog. Support and installation are unknown.');
  return parsed.data.data;
}
