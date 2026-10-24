import type { FileUploadApi } from "@/components/shared/file-upload";
import {
  deleteSessionFile as apiDeleteSessionFile,
  listSessionFiles as apiListSessionFiles,
  uploadSessionFile as apiUploadSessionFile,
} from "@/lib/clients/session-client";

export const sessionFileUploadApi: FileUploadApi = {
  list: (ownerId) => apiListSessionFiles(ownerId),
  upload: (ownerId, file) => apiUploadSessionFile(ownerId, file),
  delete: (ownerId, filename) => apiDeleteSessionFile(ownerId, filename),
};
