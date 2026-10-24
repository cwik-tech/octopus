import type { FileUploadApi } from "@/components/shared/file-upload";
import { getApiBaseUrl } from "@/lib/utils/desktop";
import type { SessionFile } from "@/lib/models/session-model";
import { sessionFilesPayloadSchema } from '@contracts/sessions';
import {
  UPLOADABLE_DOCUMENT_ACCEPT,
  UPLOADABLE_DOCUMENT_HELPER,
} from "@/lib/utils/uploadable-formats";

const API_BASE = getApiBaseUrl();

function toUrl(path: string): string {
  return `${API_BASE}${path}`;
}

async function expectOk(response: Response): Promise<Response> {
  if (response.ok) return response;
  const fallbackMessage = `${response.status} ${response.statusText || "Error"}`;
  try {
    const payload = (await response.json()) as { error?: string };
    throw new Error(payload.error || fallbackMessage);
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error(fallbackMessage, { cause: error });
    }
    throw error;
  }
}

export async function listTeamFiles(ownerId: string): Promise<SessionFile[]> {
  const response = await expectOk(
    await fetch(
      toUrl(`/create/team-files/${encodeURIComponent(ownerId)}/files`),
    ),
  );
  const payload = sessionFilesPayloadSchema.parse(await response.json());
  return payload.files;
}

export async function uploadTeamFile(
  ownerId: string,
  file: File,
): Promise<SessionFile> {
  const buffer = await file.arrayBuffer();
  const response = await expectOk(
    await fetch(
      toUrl(`/create/team-files/${encodeURIComponent(ownerId)}/files`),
      {
        method: "POST",
        headers: {
          "content-type": file.type || "application/octet-stream",
          "x-filename": encodeURIComponent(file.name),
        },
        body: buffer,
      },
    ),
  );
  return (await response.json()) as SessionFile;
}

export async function deleteTeamFile(
  ownerId: string,
  filename: string,
): Promise<void> {
  await expectOk(
    await fetch(
      toUrl(
        `/create/team-files/${encodeURIComponent(ownerId)}/files/${encodeURIComponent(filename)}`,
      ),
      {
        method: "DELETE",
      },
    ),
  );
}

export const TEAM_CONTEXT_FILE_ACCEPT = UPLOADABLE_DOCUMENT_ACCEPT;

export const TEAM_CONTEXT_FILE_HELPER = `${UPLOADABLE_DOCUMENT_HELPER} Up to 8 documents.`;

export const teamFileUploadApi: FileUploadApi = {
  list: (ownerId) => listTeamFiles(ownerId),
  upload: (ownerId, file) => uploadTeamFile(ownerId, file),
  delete: (ownerId, filename) => deleteTeamFile(ownerId, filename),
};
