import type { BuiltInUpdateSource } from "@contracts/builtin-update";
import { resourcePackagePreviewSchema, resourcePackageCommitResultSchema, resourcePackageExportResultSchema, type ResourcePackageExport, type ResourcePackagePreview, type ResourcePackageResolution } from '@contracts/resource-package';
import { getApiBaseUrl } from '@/lib/utils/desktop';

async function request<T>(path: string, body: unknown, parse: (payload: unknown) => T, signal?: AbortSignal): Promise<T> {
  const deadline = AbortSignal.timeout(120_000);
  const response = await fetch(`${getApiBaseUrl()}/resource-library/packages/${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
  });
  const payload: unknown = await response.json();
  if (!response.ok) {
    const message = typeof payload === 'object' && payload !== null && 'error' in payload && typeof payload.error === 'string' ? payload.error : `Package request failed (${response.status})`;
    throw new Error(message);
  }
  return parse(payload);
}
export function previewResourcePackage(input: { contentBase64: string; filename: string }, signal?: AbortSignal) {
  return request('preview', input, resourcePackagePreviewSchema.parse, signal);
}
export function importResourcePackage(input: { contentBase64: string; filename: string; digest: string; expectedGeneration: number; resolutions: ResourcePackageResolution[]; runtimeTargets: Pick<ResourcePackagePreview, 'agents' | 'teams'>; builtinUpdate?: BuiltInUpdateSource }, signal?: AbortSignal) {
  return request('import', input, resourcePackageCommitResultSchema.parse, signal);
}
export function exportResourcePackage(input: ResourcePackageExport, signal?: AbortSignal) {
  return request('export', input, resourcePackageExportResultSchema.parse, signal);
}

export function exportBuiltinUpdate(input: BuiltInUpdateSource, signal?: AbortSignal) { return request('builtin-update', input, resourcePackageExportResultSchema.parse, signal); }
