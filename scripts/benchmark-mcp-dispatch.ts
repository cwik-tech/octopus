import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { pathToFileURL } from 'node:url'

import {
  runMcpBrokerEchoBenchmark,
  type McpBrokerEchoBenchmarkOptions,
} from './benchmark-capability-dispatch.js'

interface CliOptions extends McpBrokerEchoBenchmarkOptions {
  readonly outputPath?: string
}

function parseArguments(argv: readonly string[]): CliOptions {
  let moduleRoot = process.cwd()
  let iterations = 200
  let warmupIterations = 20
  let outputPath: string | undefined
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index]
    const value = argv[index + 1]
    if (name === '--module-root' && value) {
      moduleRoot = value
      index += 1
    } else if (name === '--iterations' && value) {
      iterations = parseInteger(value, name)
      index += 1
    } else if (name === '--warmup' && value) {
      warmupIterations = parseInteger(value, name)
      index += 1
    } else if (name === '--output' && value) {
      outputPath = value
      index += 1
    } else {
      throw new Error(`Unknown or incomplete benchmark argument: ${name ?? ''}`)
    }
  }
  return {
    moduleRoot,
    iterations,
    warmupIterations,
    ...(outputPath ? { outputPath } : {}),
  }
}

function parseInteger(value: string, name: string): number {
  if (!/^\d+$/u.test(value)) throw new Error(`${name} must be an integer.`)
  return Number(value)
}

function isMainModule(moduleUrl: string): boolean {
  const entry = process.argv[1]
  return Boolean(entry && pathToFileURL(path.resolve(entry)).href === moduleUrl)
}

if (isMainModule(import.meta.url)) {
  const options = parseArguments(process.argv.slice(2))
  runMcpBrokerEchoBenchmark(options)
    .then(async (report) => {
      const serialized = `${JSON.stringify(report, null, 2)}\n`
      if (options.outputPath) {
        await fs.writeFile(path.resolve(options.outputPath), serialized, 'utf8')
      }
      process.stdout.write(serialized)
    })
    .catch((error: unknown) => {
      const message = error instanceof Error ? error.message : 'Unknown error'
      process.stderr.write(`MCP dispatch benchmark failed: ${message}\n`)
      process.exitCode = 1
    })
}
