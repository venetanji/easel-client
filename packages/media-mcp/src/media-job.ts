import { safeErrorMessage } from './media-http.js';

export const MEDIA_JOB_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,255}$/;

export interface MediaJob {
  id: string;
  status: string;
  providerStatus: string;
  progress?: number;
  seconds?: number;
  size?: string;
  error?: string;
  queuePosition?: number;
  queueAhead?: number;
  estimatedWaitSeconds?: number;
  estimatedCompletionAt?: number;
}

export function parseMediaJob(payload: any, apiKey: string, expectedId?: string): MediaJob {
  const value = payload?.data && !Array.isArray(payload.data) ? payload.data : payload;
  const id = value?.id ?? value?.video_id;
  if (typeof id !== 'string' || !MEDIA_JOB_ID_PATTERN.test(id) || (expectedId && id !== expectedId)) {
    throw new Error('The media endpoint returned an invalid or mismatched job ID. Do not resubmit a generation automatically.');
  }
  const raw = value.status;
  if (typeof raw !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(raw)) throw new Error(`Media job ${id} returned no usable status. Retrieve this job again; do not resubmit it.`);
  const normalized = raw.toLowerCase();
  const aliases: Record<string, string> = { pending: 'queued', created: 'queued', running: 'in_progress', processing: 'in_progress', succeeded: 'completed', ready: 'completed', done: 'completed', error: 'failed', canceled: 'cancelled' };
  const job: MediaJob = { id, status: aliases[normalized] || normalized, providerStatus: raw };
  if (typeof value.progress === 'number' && Number.isFinite(value.progress)) job.progress = Math.max(0, Math.min(100, value.progress));
  const seconds = Number(value.seconds);
  if (Number.isFinite(seconds) && seconds > 0 && seconds <= 3_600) job.seconds = seconds;
  if (typeof value.size === 'string' && /^\d{2,5}x\d{2,5}$/.test(value.size)) job.size = value.size;
  if (value.error) job.error = safeErrorMessage(value.error?.message || value.error, apiKey, 500);
  for (const [remote, local] of Object.entries({ queue_position: 'queuePosition', queue_ahead: 'queueAhead', estimated_wait_seconds: 'estimatedWaitSeconds', estimated_completion_at: 'estimatedCompletionAt' })) {
    if (typeof value[remote] === 'number' && Number.isFinite(value[remote]) && value[remote] >= 0) (job as any)[local] = value[remote];
  }
  return job;
}
