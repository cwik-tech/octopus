import { describe, expect, it } from "vitest";

import {
  arrayBufferToBase64,
  filesToPayload,
} from "../package-file-payload";

describe("package file payloads", () => {
  it("encodes buffers larger than one conversion chunk", () => {
    const bytes = new Uint8Array(0x8000 + 7);
    bytes.fill(65);

    const encoded = arrayBufferToBase64(bytes.buffer);

    expect(encoded).toBe(window.btoa("A".repeat(bytes.length)));
  });

  it("prefers webkitRelativePath and falls back to the file name", async () => {
    const nested = fakeFile("skill.md", "research/skill.md", "nested");
    const plain = fakeFile("notes.txt", "", "plain");

    await expect(filesToPayload(fakeFileList(nested, plain))).resolves.toEqual([
      {
        relativePath: "research/skill.md",
        contentBase64: window.btoa("nested"),
      },
      {
        relativePath: "notes.txt",
        contentBase64: window.btoa("plain"),
      },
    ]);
  });
});

function fakeFile(
  name: string,
  webkitRelativePath: string,
  content: string,
): File {
  return {
    name,
    webkitRelativePath,
    arrayBuffer: async () => new TextEncoder().encode(content).buffer,
  } as File;
}

function fakeFileList(...files: File[]): FileList {
  return Object.assign(files, {
    item: (index: number) => files[index] ?? null,
  }) as unknown as FileList;
}
