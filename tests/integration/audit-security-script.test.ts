import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'

const repoRoot = process.cwd()

function runAuditWithFakeNpm(
  mode: 'success' | 'structured-high' | 'registry-error' | 'malformed-high',
) {
  const fakeBin = fs.mkdtempSync(path.join(os.tmpdir(), 'audit-security-npm-'))
  const npmPath = path.join(fakeBin, 'npm')
  fs.writeFileSync(
    npmPath,
    [
      '#!/bin/sh',
      'if [ "$FAKE_AUDIT_MODE" = "registry-error" ]; then',
      "  printf '%s\\n' '{\"error\":{\"code\":\"ENETUNREACH\",\"summary\":\"registry unavailable\"}}'",
      '  exit 1',
      'fi',
      'if [ "$FAKE_AUDIT_MODE" = "malformed-high" ]; then',
      '  case "$PWD" in',
      '    */ui)',
      "      printf '%s\\n' '{\"auditReportVersion\":2,\"vulnerabilities\":{\"opaque-package\":{\"severity\":\"high\",\"via\":[\"missing-advisory-object\"]}},\"metadata\":{\"vulnerabilities\":{\"info\":0,\"low\":0,\"moderate\":0,\"high\":1,\"critical\":0,\"total\":1}}}'",
      '      exit 1',
      '      ;;',
      '  esac',
      'fi',
      'case "$PWD" in',
      '  */ui|*/file-parser)',
      "    printf '%s\\n' '{\"auditReportVersion\":2,\"vulnerabilities\":{},\"metadata\":{\"vulnerabilities\":{\"info\":0,\"low\":0,\"moderate\":0,\"high\":0,\"critical\":0,\"total\":0}}}'",
      '    ;;',
      '  *)',
      '    if [ "$FAKE_AUDIT_MODE" = "structured-high" ]; then',
      "      printf '%s\\n' '{\"auditReportVersion\":2,\"vulnerabilities\":{\"blocked-package\":{\"severity\":\"high\",\"via\":[{\"source\":1234567,\"name\":\"blocked-package\",\"severity\":\"high\",\"title\":\"blocked fixture advisory\"}]}},\"metadata\":{\"vulnerabilities\":{\"info\":0,\"low\":0,\"moderate\":0,\"high\":1,\"critical\":0,\"total\":1}}}'",
      '    else',
      "      printf '%s\\n' '{\"auditReportVersion\":2,\"vulnerabilities\":{},\"metadata\":{\"vulnerabilities\":{\"info\":0,\"low\":0,\"moderate\":0,\"high\":0,\"critical\":0,\"total\":0}}}'",
      '    fi',
      '    ;;',
      'esac',
      'exit 0',
      '',
    ].join('\n'),
    { mode: 0o755 },
  )

  try {
    return spawnSync(process.execPath, ['scripts/audit-security.mjs'], {
      cwd: repoRoot,
      encoding: 'utf8',
      env: {
        ...process.env,
        FAKE_AUDIT_MODE: mode,
        PATH: `${fakeBin}${path.delimiter}${process.env.PATH ?? ''}`,
      },
    })
  } finally {
    fs.rmSync(fakeBin, { recursive: true, force: true })
  }
}

test('security audit accepts complete reports with no high or critical advisories', () => {
  const result = runAuditWithFakeNpm('success')
  assert.equal(result.status, 0, result.stderr)
  assert.match(result.stdout, /root: no high or critical advisories/)
})

test('security audit blocks a complete high-severity advisory', () => {
  const result = runAuditWithFakeNpm('structured-high')
  assert.equal(result.status, 1)
  assert.match(result.stdout, /blocked high blocked-package 1234567/)
})

test('security audit fails closed when npm reports a registry error as JSON', () => {
  const result = runAuditWithFakeNpm('registry-error')
  assert.equal(result.status, 1)
  assert.match(result.stderr, /incomplete report: registry unavailable/)
  assert.doesNotMatch(result.stdout, /no high or critical advisories/)
})

test('security audit fails closed when high metadata has no structured advisory', () => {
  const result = runAuditWithFakeNpm('malformed-high')
  assert.equal(result.status, 1)
  assert.match(
    result.stderr,
    /high vulnerability 'opaque-package'.*complete structured advisory object/,
  )
})
