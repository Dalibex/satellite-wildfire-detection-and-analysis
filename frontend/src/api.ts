import { z } from 'zod';
import { assignmentsValid, jobSchema, uploadSchema } from './domain';
import type { AnalysisOptions, Composition, Job, UploadedImage } from './domain';

const origin = (import.meta.env.VITE_API_BASE_URL ?? '').replace(/\/$/, '');
export const statelessApi = import.meta.env.VITE_STATELESS_API === 'true';
const inputFiles = new Map<string, File>();
const resultAssets = new Map<string, string>();
export function apiUrl(path: string): string {
  if (path.startsWith('data:') || path.startsWith('blob:')) return path;
  return resultAssets.get(path) ?? `${origin}${path}`;
}
export function releaseUpload(id: string): void { inputFiles.delete(id); }
export function clearResultAssets(): void {
  for (const url of resultAssets.values()) URL.revokeObjectURL(url);
  resultAssets.clear();
}
export function assetUrl(jobId: string, filename: string): string {
  return apiUrl(`/api/analyses/${encodeURIComponent(jobId)}/files/${encodeURIComponent(filename)}`);
}

export class ApiError extends Error {
  constructor(public readonly code: string) { super(code); }
}

async function request<T>(path: string, schema: z.ZodType<T>, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(apiUrl(path), options); }
  catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') throw error;
    throw new ApiError('network');
  }
  let body: unknown;
  try { body = await response.json(); }
  catch { throw new ApiError(response.status === 413 ? 'request_too_large' : response.status === 504 ? 'analysis_timeout' : 'invalid_response'); }
  if (!response.ok) {
    const failure = z.object({ code: z.string() }).safeParse(body);
    throw new ApiError(failure.success ? failure.data.code : 'unknown');
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    console.error('Invalid API response', { path, issues: parsed.error.issues });
    throw new ApiError('invalid_response');
  }
  return parsed.data;
}

export async function uploadImage(file: File, signal: AbortSignal): Promise<z.infer<typeof uploadSchema>> {
  if (statelessApi && file.size > 4 * 1024 * 1024) throw new ApiError('request_too_large');
  const form = new FormData();
  form.append('file', file);
  const uploaded = await request('/api/uploads', uploadSchema, { method: 'POST', body: form, signal });
  if (statelessApi) inputFiles.set(uploaded.id, file);
  return uploaded;
}
export async function startAnalysis(images: UploadedImage[], options: AnalysisOptions, signal: AbortSignal): Promise<Job> {
  if (!assignmentsValid(images)) return Promise.reject(new ApiError('invalid_compositions'));
  const assignments: Partial<Record<Composition, string>> = {};
  for (const image of images) {
    if (image.assignment !== 'unused') assignments[image.assignment] = image.id;
  }
  if (statelessApi) {
    clearResultAssets();
    const form = new FormData();
    let total = 0;
    for (const [kind, id] of Object.entries(assignments)) {
      const file = inputFiles.get(id);
      if (!file) throw new ApiError('upload_not_found');
      total += file.size;
      form.append(kind, file);
    }
    if (total > 4 * 1024 * 1024) throw new ApiError('request_too_large');
    form.append('options', JSON.stringify({ ...assignments, max_side: options.max_side, smoke_recovery: true }));
    const response = await request('/api/process', z.object({ job: jobSchema, assets: z.record(z.string(), z.string()) }),
      { method: 'POST', body: form, signal });
    for (const [filename, encoded] of Object.entries(response.assets)) {
      const content = Uint8Array.from(atob(encoded), character => character.charCodeAt(0));
      const type = filename.endsWith('.svg') ? 'image/svg+xml' : filename.endsWith('.png') ? 'image/png' : 'application/json';
      const path = `/api/analyses/${encodeURIComponent(response.job.id)}/files/${encodeURIComponent(filename)}`;
      resultAssets.set(path, URL.createObjectURL(new Blob([content], { type })));
    }
    return response.job;
  }
  return request('/api/analyses', jobSchema, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...assignments, max_side: options.max_side, smoke_recovery: true }), signal,
  });
}
export function getAnalysis(id: string, signal: AbortSignal): Promise<Job> {
  return request(`/api/analyses/${encodeURIComponent(id)}`, jobSchema, { signal });
}
