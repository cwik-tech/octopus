import type { AgentPackageFileInput } from "@/lib/models/agent-generator-model";

export async function filesToPayload(
  fileList: FileList,
): Promise<AgentPackageFileInput[]> {
  return Promise.all(
    Array.from(fileList).map(async (file) => ({
      relativePath:
        (file as File & { webkitRelativePath?: string }).webkitRelativePath ||
        file.name,
      contentBase64: arrayBufferToBase64(await file.arrayBuffer()),
    })),
  );
}

export function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    const chunk = bytes.subarray(index, index + 0x8000);
    binary += String.fromCharCode(...chunk);
  }
  return window.btoa(binary);
}
