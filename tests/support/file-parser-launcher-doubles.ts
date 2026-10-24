import type { FileParseRequest } from "../../core/file-parser-launcher.js";

/**
 * `parseFile` for a parser double whose test only parses directories. A call means the code under
 * test took a path the test does not cover, so it fails loudly instead of passing quietly.
 */
export async function parseFileNotExpected(input: FileParseRequest): Promise<void> {
  throw new Error(
    `This test's parser double does not parse single files: ${input.filePath}`,
  );
}
