import { z } from 'zod/v4';
export const MAX_SOURCE_AUDIO_BYTES = 32 * 1024 * 1024;
// Keep aligned with easel/source_audio.py AUDIO_MIME_TYPES. Server owns decoding.
export const SOURCE_AUDIO_MIME_TYPES = ['audio/wav','audio/x-wav','audio/wave','audio/mpeg','audio/mp3','audio/flac','audio/x-flac','audio/ogg','application/ogg','audio/mp4','audio/x-m4a','application/octet-stream'] as const;
export const SourceAudioSchema = z.object({data:z.string().min(1).max(Math.ceil(MAX_SOURCE_AUDIO_BYTES/3)*4),mimeType:z.enum(SOURCE_AUDIO_MIME_TYPES),name:z.string().regex(/^[A-Za-z0-9._-]{1,128}$/).optional()}).strict();
export type SourceAudioUpload = z.infer<typeof SourceAudioSchema>;
export function decodeSourceAudio(value: SourceAudioUpload): {bytes:Buffer;mimeType:string;name:string} {
  const input=SourceAudioSchema.parse(value);
  if(input.data.length%4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.data)) throw new Error('Source audio requires canonical base64 bytes.');
  const bytes=Buffer.from(input.data,'base64');
  if(!bytes.length || bytes.length>MAX_SOURCE_AUDIO_BYTES || bytes.toString('base64')!==input.data) throw new Error('Source audio must be nonempty canonical base64 and at most 32 MiB.');
  return {bytes,mimeType:input.mimeType,name:input.name || 'source-audio'};
}
