import { whenDefined } from '../core/optional-properties.js'
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import * as path from "node:path";

import {
  fileParserEnvironment,
  runFileParserProcess,
  singleFileParserArgs,
  type FileParseRequest,
  type FileParserProcessOptions,
  type FileParserLauncher,
  type FileParserRequestOptions,
  type SpawnFileParserProcess,
} from "../core/file-parser-launcher.js";
import { requireDesktopHeadlessNodePath } from "./headless-node-runtime.js";

export function resolveDesktopFileParserEntry(appRootPath: string): string {
  return path.join(path.resolve(appRootPath), "file-parser", "dist", "index.js");
}

export class ElectronFileParserLauncher implements FileParserLauncher {
  constructor(
    private readonly appRootPath: string,
    private readonly executablePath = requireDesktopHeadlessNodePath(process.execPath),
    private readonly spawnProcess: SpawnFileParserProcess = (
      command,
      args,
      options,
    ) => spawn(command, [...args], options),
    private readonly processOptions: Pick<
      FileParserProcessOptions,
      "timeoutMs" | "terminationGraceMs"
    > = {},
  ) {}

  async parseDirectory(
    inputDir: string,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser([path.resolve(inputDir)], false, options);
  }

  async parseFile(
    input: FileParseRequest,
    options: FileParserRequestOptions = {},
  ): Promise<void> {
    await this.runParser(singleFileParserArgs(input), input.localOnly, options);
  }

  private async runParser(
    parserArgs: readonly string[],
    localOnly: boolean,
    options: FileParserRequestOptions,
  ): Promise<void> {
    const parserEntry = resolveDesktopFileParserEntry(this.appRootPath);
    if (!existsSync(parserEntry)) {
      throw new Error(`Bundled file parser is missing: ${parserEntry}`);
    }
    await runFileParserProcess({
      command: this.executablePath,
      args: [parserEntry, ...parserArgs],
      cwd: path.dirname(parserEntry),
      env: {
        ...fileParserEnvironment(process.env, localOnly),
        ELECTRON_RUN_AS_NODE: "1",
      },
      spawnProcess: this.spawnProcess,
      ...whenDefined(options.signal, (signal) => ({ signal: signal })),
      ...this.processOptions,
    });
  }
}
