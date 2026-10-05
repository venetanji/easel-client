import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { captureCanvasScreenshot, type CanvasScreenshot } from './canvas.js';
import {
  createImageVariations, editImages, generateImages, getImageJob, listModels,
  type EaselImage, type ImageResult, type EditImageInput, type GenerateImageInput, type ImageVariationInput,
} from './easel.js';
import { MAX_IMAGE_BASE64_CHARS, MAX_IMAGE_INPUTS } from './image-upload.js';
import { generateVideo, getVideo, discoverVideoCapabilities, listVideoLoras, VIDEO_ID_PATTERN, type GenerateVideoInput, type GetVideoInput, type VideoJob, type VideoResult, type VideoDiscoveryInput, type VideoCapabilities, type VideoLora } from './video.js';
import { VideoGenerationSchema } from './video-input.js';

interface EaselClient {
  listModels: (input?: { signal?: AbortSignal }) => Promise<string[]>;
  generateImages: (input: GenerateImageInput) => Promise<ImageResult>;
  editImages?: (input: EditImageInput) => Promise<ImageResult>;
  createImageVariations?: (input: ImageVariationInput) => Promise<ImageResult>;
  getImageJob?: (input: { jobId: string; model?: string; signal?: AbortSignal }) => Promise<{ job: VideoJob; images?: EaselImage[] }>;
  generateVideo?: (input: GenerateVideoInput) => Promise<VideoJob>;
  discoverVideoCapabilities?: (input: VideoDiscoveryInput) => Promise<VideoCapabilities>;
  listVideoLoras?: (input: VideoDiscoveryInput) => Promise<VideoLora[]>;
  getVideo?: (input: GetVideoInput) => Promise<VideoResult>;
}

interface CanvasRenderer {
  capture: (input: {
    html: string;
    assets?: Array<{ name: string; data: string; mimeType: string }>;
    viewport?: { width: number; height: number };
  }) => Promise<CanvasScreenshot>;
}

type ToolRegistrar = Pick<McpServer, 'registerTool'>;

const ListModelsInput = z.object({}).strict();
const GenerateImageInput = z.object({
  prompt: z.string().trim().min(1).max(5_000),
  model: z.string().trim().max(200).optional(),
  size: z.string().regex(/^\d{2,5}x\d{2,5}$/).optional(),
  n: z.number().int().min(1).max(4).optional(),
}).strict();
const ImageUploadInput = z.object({
  data: z.string().min(1).max(MAX_IMAGE_BASE64_CHARS),
  mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  name: z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional(),
}).strict();
const EditImageInput = GenerateImageInput.extend({
  images: z.array(ImageUploadInput).min(1).max(MAX_IMAGE_INPUTS),
  mask: ImageUploadInput.extend({ mimeType: z.literal('image/png') }).strict().optional(),
  size: z.union([z.literal('auto'), z.string().regex(/^\d{2,5}x\d{2,5}$/)]).optional(),
}).strict();
const ImageVariationInput = GenerateImageInput.omit({ prompt: true }).extend({
  image: ImageUploadInput,
}).strict();
const GenerateVideoInput = VideoGenerationSchema;
const GetVideoInput = z.object({
  videoId: z.string().regex(VIDEO_ID_PATTERN),
  model: z.string().trim().min(1).max(320).optional(),
  waitSeconds: z.number().int().min(0).max(15).optional(),
  download: z.boolean().optional(),
  includeQueue: z.boolean().describe('Include queue position and estimated completion time when the endpoint supports /v1/videos/queue/{id}.').optional(),
}).strict();
const ConfiguredMediaModels = z.array(z.object({
  id: z.string().min(1).max(320),
  model: z.string().min(1).max(256),
  name: z.string(),
  endpointName: z.string(),
  baseUrl: z.string().url().refine((value) => ['http:', 'https:'].includes(new URL(value).protocol)),
  apiKey: z.string().max(4096),
  mediaTypes: z.array(z.enum(['image', 'video', 'audio'])).max(3).optional(),
}).strict()).max(4096);
const CaptureCanvasInput = z.object({
  html: z.string().min(1).max(1_048_576),
  assets: z.array(z.object({
    name: z.string().regex(/^[A-Za-z0-9_-]{1,64}$/),
    data: z.string(),
    mimeType: z.enum(['image/png', 'image/jpeg', 'image/webp']),
  }).strict()).max(8).optional(),
  viewport: z.object({
    width: z.number().int().min(320).max(1920),
    height: z.number().int().min(240).max(1080),
  }).strict().optional(),
}).strict();

export function registerMediaTools(
  server: ToolRegistrar,
  dependencies: { easel?: EaselClient; canvas?: CanvasRenderer } = {},
): void {
  const configured = !dependencies.easel && process.env.EASEL_MEDIA_MODELS !== undefined
    ? ConfiguredMediaModels.parse(JSON.parse(process.env.EASEL_MEDIA_MODELS)) : null;
  const providerFor = (id?: string, mediaType: 'image' | 'video' = 'image') => {
    if (configured) {
      const selected = configured.find((model) => model.id === id);
      if (!selected) throw new Error('Choose an enabled Media model returned by list_models.');
      if (selected.mediaTypes?.length && !selected.mediaTypes.includes(mediaType)) throw new Error(`Choose a ${mediaType} generation model returned by list_models.`);
      return { model: selected.model, baseUrl: selected.baseUrl, apiKey: selected.apiKey };
    }
    return { model: id, baseUrl: process.env.EASEL_BASE_URL, apiKey: process.env.EASEL_API_KEY };
  };
  const easel: EaselClient = dependencies.easel || {
    listModels: (input = {}) => configured ? Promise.resolve(configured.map((model) => model.id)) : listModels({
      baseUrl: process.env.EASEL_BASE_URL,
      apiKey: process.env.EASEL_API_KEY,
      signal: input.signal,
    }),
    generateImages: (input) => generateImages({ ...input, ...providerFor(input.model) }),
    editImages: (input) => editImages({ ...input, ...providerFor(input.model) }),
    createImageVariations: (input) => createImageVariations({ ...input, ...providerFor(input.model) }),
    getImageJob: (input) => getImageJob({ ...input, ...providerFor(input.model) }),
    generateVideo: (input) => {
      const provider = providerFor(input.model, 'video');
      return generateVideo({ ...input, ...provider, model: provider.model! });
    },
    getVideo: (input) => getVideo({ ...input, ...providerFor(input.model, 'video') }),
    discoverVideoCapabilities: (input) => { const provider = providerFor(input.model, 'video'); return discoverVideoCapabilities({ ...input, ...provider, model: provider.model! }); },
    listVideoLoras: (input) => { const provider = providerFor(input.model, 'video'); return listVideoLoras({ ...input, ...provider, model: provider.model! }); },
  };
  const canvas = dependencies.canvas || {
    capture: (input: Parameters<CanvasRenderer['capture']>[0]) => captureCanvasScreenshot(input),
  };

  server.registerTool('list_models', {
    description: 'List enabled Media models, exact tool IDs, endpoint names and discovered output types. Image/video generation and reference support depend on the endpoint. Audio generation tools are not yet implemented.',
    inputSchema: ListModelsInput,
  }, async (_input, extra) => {
    const models = await easel.listModels({ signal: extra?.signal });
    const available = configured ? configured.map(({ id, model, name, endpointName, mediaTypes }) => ({ id, model, name, endpointName, mediaTypes: mediaTypes?.length ? mediaTypes : ['unknown'] })) : models;
    return {
      content: [{ type: 'text', text: `Available Media models: ${JSON.stringify(available)}` }],
      structuredContent: { models: available },
    };
  });

  const modelsFor = (type: 'image' | 'video') => configured?.filter((model) => !model.mediaTypes?.length || model.mediaTypes.includes(type));
  const imageModels = modelsFor('image');
  if (!imageModels || imageModels.length) {
    const model = imageModels ? z.enum(imageModels.map((model) => model.id)) : GenerateImageInput.shape.model;
    server.registerTool('generate_image', {
      description: 'Generate images with an enabled Media model. Use the exact model ID returned by list_models; its endpoint credentials are applied automatically.',
      inputSchema: GenerateImageInput.extend({ model }).strict(),
    }, async (input, extra) => imageToolResult(await easel.generateImages({ ...input, signal: extra?.signal }), 'Generated', input.model));
    if (easel.getImageJob) server.registerTool('get_image_job', {
      description: 'Retrieve an accepted queued image job using its original ID and model. Uses Easel’s /v1/images/jobs/{id} contract; only use for an endpoint that returned a queued image receipt. Pending jobs are monitored automatically in Easel client. Never resubmit a queued image job.',
      inputSchema: z.object({ jobId: z.string().regex(VIDEO_ID_PATTERN), model }).strict(),
    }, async (input, extra) => {
      const result = await easel.getImageJob!({ ...input, signal: extra?.signal });
      const output = imageToolResult(result.images || { job: result.job }, 'Generated', input.model);
      return { ...output, structuredContent: { ...output.structuredContent, job: { ...result.job, modelId: input.model } } };
    });

    if (easel.editImages) server.registerTool('edit_image', {
      description: 'Edit 1-16 supplied reference images with a prompt using the selected Media model and its endpoint credentials. Accepts PNG/JPEG/WebP base64 bytes, at most 32 MiB combined. Optional PNG mask must match the first image and be smaller than 4 MiB; mask support depends on the provider. Easel supports reference edits and rejects masks. dall-e-2 requires one square PNG smaller than 4 MiB.',
      inputSchema: EditImageInput.extend({ model }).strict(),
    }, async (input, extra) => imageToolResult(await easel.editImages!({ ...input, signal: extra?.signal }), 'Edited', input.model));

    if (easel.createImageVariations) server.registerTool('create_image_variation', {
      description: 'Create variations from one PNG/JPEG/WebP reference image (at most 32 MiB) using the selected Media model and its endpoint credentials. Provider support varies. Easel accepts portrait and JPEG references; dall-e-2 requires a square PNG smaller than 4 MiB and a 256x256, 512x512, or 1024x1024 output size.',
      inputSchema: ImageVariationInput.extend({ model }).strict(),
    }, async (input, extra) => imageToolResult(await easel.createImageVariations!({ ...input, signal: extra?.signal }), 'Created variations of', input.model));
  }

  const videoModels = modelsFor('video');
  if (!videoModels || videoModels.length) {
    const model = videoModels ? z.enum(videoModels.map((model) => model.id)) : GenerateVideoInput.shape.model;
    if (easel.discoverVideoCapabilities) server.registerTool('discover_video_capabilities', {
      description: 'Read the selected video endpoint capabilities without generation or uploads. Returns duration/size/seed bounds, typed controls and guide-node availability. Code support and available nodes do not prove GPU execution or visual quality. Unsupported endpoints fail explicitly.',
      inputSchema: z.object({ model }).strict(),
    }, async (input, extra) => {
      const capabilities = await easel.discoverVideoCapabilities!({ ...input, signal: extra?.signal });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ modelId: input.model, capabilities }) }], structuredContent: { modelId: input.model, capabilities } };
    });
    if (easel.listVideoLoras) server.registerTool('list_video_loras', {
      description: 'Read curated video LoRAs for the selected endpoint without generation or uploads. Keep supported, installed, required inputs, validation and provenance distinct. Copy exact IDs; installation alone does not certify execution or visual quality.',
      inputSchema: z.object({ model }).strict(),
    }, async (input, extra) => {
      const loras = await easel.listVideoLoras!({ ...input, signal: extra?.signal });
      return { content: [{ type: 'text' as const, text: JSON.stringify({ modelId: input.model, loras }) }], structuredContent: { modelId: input.model, loras } };
    });
    if (easel.generateVideo) server.registerTool('generate_video', {
      description: 'Submit one video job using the exact video Media model ID. Read discover_video_capabilities and list_video_loras for advanced controls. Typed camera/LoRA/seed/slow-motion/Ingredients and guidingFrames options map to the API; never supply raw JSON, paths or URLs. PNG/JPEG/WebP references share a 32 MiB limit. Temporal guides (at most 8 unique pixel-frame indices, 24 FPS, 0..seconds*24) cannot combine with inputReference or Ingredients. Seed is an exact decimal string. Omit size unless requested; never derive it from reference dimensions. Duration defaults to 4 seconds; Easel accepts integers 1-12. Returns a durable job ID; the host monitors and previews it. End after acceptance; do not poll or resubmit. Stop does not cancel accepted jobs.',
      inputSchema: GenerateVideoInput.extend({ model }).strict(),
    }, async (input, extra) => {
      try { return videoToolResult({ job: await easel.generateVideo!({ ...input, signal: extra?.signal }) }, input.model); }
      catch (error) {
        if (!(error instanceof Error) || !('code' in error) || error.code !== 'INVALID_TOOL_ARGUMENTS' || !('requestSent' in error) || error.requestSent !== false) throw error;
        return { isError: true, content: [{ type: 'text' as const, text: error.message }], structuredContent: { error: error.message, code: 'INVALID_TOOL_ARGUMENTS', stage: 'argument_validation', requestSent: false } };
      }
    });
    if (easel.getVideo) server.registerTool('get_video', {
      description: 'Retrieve a video job using its ID and the SAME model ID as generate_video. Optional waitSeconds (0-15) checks every 3 seconds. A completed job downloads MP4/WebM up to 32 MiB by default; download:false checks status only. Pending jobs are safe to retrieve later without resubmission. Return to the user instead of repeatedly polling in one turn.',
      inputSchema: GetVideoInput.extend({ model: videoModels ? model : GetVideoInput.shape.model }).strict(),
    }, async (input, extra) => videoToolResult(await easel.getVideo!({ ...input, signal: extra?.signal }), input.model));
  }

  server.registerTool('capture_canvas_screenshot', {
    description: 'Render offline HTML/JavaScript with local image assets and return a PNG screenshot.',
    inputSchema: CaptureCanvasInput,
  }, async (input) => {
    const screenshot = await canvas.capture(input);
    return {
      content: [
        { type: 'text', text: 'Canvas screenshot captured.' },
        { type: 'image', data: screenshot.data.toString('base64'), mimeType: screenshot.mimeType },
      ],
      structuredContent: { mimeType: screenshot.mimeType },
    };
  });
}

function imageToolResult(images: ImageResult, verb: string, modelId?: string) {
  if (!Array.isArray(images)) return videoToolResult({ job: images.job }, modelId, 'image');
  return {
    content: [
      { type: 'text' as const, text: `${verb} ${images.length} image${images.length === 1 ? '' : 's'}.` },
      ...images.map((image) => ({ type: 'image' as const, data: image.data, mimeType: image.mimeType })),
    ],
    structuredContent: { count: images.length, mimeTypes: images.map((image) => image.mimeType) },
  };
}

function videoToolResult(result: VideoResult, modelId?: string, mediaType: 'image' | 'video' = 'video') {
  const job = { ...result.job, ...(modelId ? { modelId } : {}) };
  return {
    content: [
      { type: 'text' as const, text: JSON.stringify({ job, downloaded: Boolean(result.media), ...(!['completed', 'failed', 'cancelled'].includes(job.status) ? { retryAfterSeconds: 15, guidance: `Keep this job ID. Retrieve it later with ${mediaType === 'image' ? 'get_image_job' : 'get_video'}; do not resubmit.` } : {}) }) },
      ...(result.media ? [{ type: 'resource' as const, resource: { uri: `easel-media://videos/${encodeURIComponent(job.id)}`, mimeType: result.media.mimeType, blob: result.media.data } }] : []),
    ],
    structuredContent: { job, downloaded: Boolean(result.media) },
  };
}

export function createMediaServer(dependencies: { easel?: EaselClient; canvas?: CanvasRenderer } = {}): McpServer {
  const server = new McpServer({ name: 'easel-media', version: '0.0.2' });
  registerMediaTools(server, dependencies);
  return server;
}
