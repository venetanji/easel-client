import { z } from 'zod/v4';
import { headers, normalizeEaselBaseUrl, requestBinary, requestSignal, type ProviderOptions } from './media-http.js';
export const ModelGuideInputSchema = z.object({ model: z.string().trim().min(1).max(320), mode: z.string().regex(/^[a-z0-9_-]{1,32}$/).describe('Model-specific guide mode: qwen-image-2.1 uses generation/editing; minimax-h3 uses base for text-to-video or first-frame image-to-video (also with source audio), reference for REF20 semantic references. Other pairs may be unavailable.') }).strict();
export type ModelGuideInput = z.infer<typeof ModelGuideInputSchema> & { signal?: AbortSignal };
const GuideSchema = z.object({version:z.literal(1),guide_id:z.string().min(1).max(128),model:z.string().min(1).max(256),mode:z.string().min(1).max(32),text:z.string().min(1),sources:z.array(z.string().url()).max(32)}).strict();
export type ModelGuide = z.infer<typeof GuideSchema>;
export async function getModelGuide(options: ModelGuideInput & ProviderOptions): Promise<ModelGuide> {
  const input=ModelGuideInputSchema.parse({model:options.model,mode:options.mode});
  const path=`/v1/models/${encodeURIComponent(input.model)}/guide?mode=${encodeURIComponent(input.mode)}`;
  const key=options.apiKey || '';
  const {bytes}=await requestBinary(normalizeEaselBaseUrl(options.baseUrl)+path,{method:'GET',headers:headers(key),signal:requestSignal(options.signal,30000)},key,options.fetchImpl || globalThis.fetch,16384,{label:'Model guide retrieval',path,model:input.model});
  const text=bytes.toString('utf8');
  if ([...new Set([key,key.trim()].filter(Boolean))].some(secret=>text.includes(secret)||text.includes(JSON.stringify(secret).slice(1,-1)))) throw new Error('Credential found in guide response.');
  const guide=GuideSchema.parse(JSON.parse(text));
  if(guide.model!==input.model || guide.mode!==input.mode) throw new Error('Guide does not match the selected model and mode.');
  return guide;
}
