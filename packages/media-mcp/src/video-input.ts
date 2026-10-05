import { z } from 'zod/v4';
import { MAX_IMAGE_BASE64_CHARS } from './image-upload.js';

export const CAMERA_LORAS = ['dolly-in', 'dolly-out', 'dolly-left', 'dolly-right', 'jib-up', 'jib-down', 'static'] as const;
export const VIDEO_SEED_MAX = '18446744073709551614';
export const VideoImageUploadSchema = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
}).strict();
export const VideoGenerationSchema = z.object({
  prompt: z.string().trim().min(1).max(5_000),
  model: z.string().trim().min(1).max(320),
  seconds: z.number().int().min(1).max(60).describe('Easel accepts 1-12 whole seconds; other endpoint limits vary.').optional(),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  inputReference: VideoImageUploadSchema.optional(),
  cameraLora: z.enum(CAMERA_LORAS).optional(),
  cameraLoraStrength: z.number().min(0).max(2).optional(),
  loras: z.array(z.object({ id: z.string().max(128).regex(/^[a-z0-9]+(?:[.-][a-z0-9]+)*$/), strength: z.number().min(0).max(2).optional() }).strict()).max(4).optional(),
  seed: z.string().regex(/^(0|[1-9][0-9]{0,19})$/).describe(`Exact decimal string from 0 to ${VIDEO_SEED_MAX}; never use a JSON number.`).optional(),
  motionSpeed: z.number().min(0.025).max(1).optional(),
  loraReference: VideoImageUploadSchema.optional(),
  loraReferenceStrength: z.number().min(0).max(1).optional(),
  guidingFrames: z.array(z.object({
    image: VideoImageUploadSchema,
    frameIndex: z.number().int().min(0).max(288).describe('Pixel-frame index at 24 FPS, no greater than seconds*24.'),
    strength: z.number().min(0).max(1).optional(),
  }).strict()).min(1).max(8).optional(),
}).strict();

export function invalidVideoArguments(message: string): never {
  throw Object.assign(new Error(message), { code: 'INVALID_TOOL_ARGUMENTS', stage: 'argument_validation', requestSent: false });
}

/** The server owns the curated registry; validate portable structure and known recipe invariants here. */
export function validateVideoInput(value: unknown): z.infer<typeof VideoGenerationSchema> {
  const parsed = VideoGenerationSchema.safeParse(value);
  if (!parsed.success) invalidVideoArguments('Invalid video arguments: ' + parsed.error.issues.map(issue => `${issue.path.join('.') || 'arguments'}: ${issue.message}`).join('; '));
  const input = parsed.data;
  const seconds = input.seconds ?? 4;
  if (input.seed !== undefined && BigInt(input.seed) > BigInt(VIDEO_SEED_MAX)) invalidVideoArguments(`seed must be an exact decimal string from 0 to ${VIDEO_SEED_MAX}.`);
  if (input.cameraLoraStrength !== undefined && !input.cameraLora) invalidVideoArguments('cameraLoraStrength requires cameraLora.');
  const ids = (input.loras || []).map(lora => lora.id);
  if (input.cameraLora) ids.push('camera-' + input.cameraLora);
  if (ids.length > 4) invalidVideoArguments('At most four LoRAs are allowed, including cameraLora.');
  if (new Set(ids).size !== ids.length) invalidVideoArguments('Duplicate LoRA IDs are not allowed, including cameraLora.');
  const ingredients = ids.includes('ingredients');
  if (ingredients) {
    if (seconds < 5) invalidVideoArguments('Ingredients requires at least 5 seconds.');
    if (!input.loraReference) invalidVideoArguments('Ingredients requires loraReference.');
    if (ids.length !== 1) invalidVideoArguments('Ingredients cannot be stacked with other LoRAs.');
  } else if (input.loraReference !== undefined || input.loraReferenceStrength !== undefined) invalidVideoArguments('loraReference and loraReferenceStrength require the ingredients LoRA.');
  if (ids.includes('slow-motion')) {
    if (input.motionSpeed === undefined) invalidVideoArguments('slow-motion requires motionSpeed.');
  } else if (input.motionSpeed !== undefined) invalidVideoArguments('motionSpeed requires the slow-motion LoRA.');
  if (ids.some(id => ['cinemagraph', 'slow-motion'].includes(id)) && !input.inputReference) invalidVideoArguments('cinemagraph and slow-motion require inputReference.');
  if (ids.includes('cinemagraph') && ids.some(id => id.startsWith('camera-') && id !== 'camera-static')) invalidVideoArguments('cinemagraph conflicts with moving camera LoRAs.');
  if (input.guidingFrames) {
    if (input.inputReference || ingredients || input.loraReference) invalidVideoArguments('guidingFrames cannot be combined with inputReference or Ingredients/loraReference.');
    if (seconds > 12) invalidVideoArguments('Easel guidingFrames require 1-12 seconds.');
    const frames = input.guidingFrames.map(guide => guide.frameIndex);
    if (new Set(frames).size !== frames.length) invalidVideoArguments('guidingFrames require unique frameIndex positions.');
    if (frames.some(frame => frame > seconds * 24)) invalidVideoArguments('guidingFrames frameIndex must not exceed seconds*24 at 24 FPS.');
  }
  return input;
}
