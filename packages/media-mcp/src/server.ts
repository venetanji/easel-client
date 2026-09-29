import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod/v4';
import { captureCanvasScreenshot, type CanvasScreenshot } from './canvas.js';
import { generateImages, listModels, type EaselImage } from './easel.js';

interface EaselClient {
  listModels: () => Promise<string[]>;
  generateImages: (input: { prompt: string; model?: string; size?: string; n?: number }) => Promise<EaselImage[]>;
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
  const easel = dependencies.easel || {
    listModels: () => listModels({
      baseUrl: process.env.EASEL_BASE_URL,
      apiKey: process.env.EASEL_API_KEY,
    }),
    generateImages: (input: { prompt: string; model?: string; size?: string; n?: number }) => generateImages({
      baseUrl: process.env.EASEL_BASE_URL,
      apiKey: process.env.EASEL_API_KEY,
      ...input,
    }),
  };
  const canvas = dependencies.canvas || {
    capture: (input: Parameters<CanvasRenderer['capture']>[0]) => captureCanvasScreenshot(input),
  };

  server.registerTool('list_models', {
    description: 'List image models available from the configured Easel server.',
    inputSchema: ListModelsInput,
  }, async () => {
    const models = await easel.listModels();
    return {
      content: [{ type: 'text', text: `Available models: ${models.join(', ')}` }],
      structuredContent: { models },
    };
  });

  server.registerTool('generate_image', {
    description: 'Generate image(s) with the configured Easel server.',
    inputSchema: GenerateImageInput,
  }, async (input) => {
    const images = await easel.generateImages(input);
    return {
      content: [
        { type: 'text', text: `Generated ${images.length} image${images.length === 1 ? '' : 's'}.` },
        ...images.map((image) => ({
          type: 'image' as const,
          data: image.data,
          mimeType: image.mimeType,
        })),
      ],
      structuredContent: { count: images.length, mimeTypes: images.map((image) => image.mimeType) },
    };
  });

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

export function createMediaServer(dependencies: { easel?: EaselClient; canvas?: CanvasRenderer } = {}): McpServer {
  const server = new McpServer({ name: 'easel-media', version: '0.0.1' });
  registerMediaTools(server, dependencies);
  return server;
}
