import assert from 'node:assert/strict'
import path from 'node:path'
import test from 'node:test'
import ts from 'typescript'

function compileExecutionJournalContractWithUiPolicy() {
  const repositoryRoot = process.cwd()
  const uiConfigPath = path.join(repositoryRoot, 'ui', 'tsconfig.app.json')
  const configFile = ts.readConfigFile(uiConfigPath, ts.sys.readFile)
  assert.equal(configFile.error, undefined)

  const parsedConfig = ts.parseJsonConfigFileContent(
    configFile.config,
    ts.sys,
    path.dirname(uiConfigPath),
  )
  const contractPath = path.join(
    repositoryRoot,
    'contracts',
    'execution-journal.ts',
  )
  const program = ts.createProgram({
    rootNames: [contractPath],
    options: parsedConfig.options,
  })
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.file?.fileName === contractPath)
    .map((diagnostic) => ({
      code: diagnostic.code,
      message: ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    }))
}

test('the execution journal contract compiles with the UI TypeScript policy', () => {
  assert.deepEqual(compileExecutionJournalContractWithUiPolicy(), [])
})
