interface OfficeToolSignature { readonly team: string | null; readonly runtime: boolean }
/** Ad hoc builds have no app team; Developer ID builds must sign every tool alike. */
export function officeToolSignatureIssue(app: OfficeToolSignature, tool: OfficeToolSignature): 'signing_team_mismatch' | 'hardened_runtime_missing' | undefined {
  if (app.team === null) return undefined
  if (tool.team !== app.team) return 'signing_team_mismatch'
  if (!tool.runtime) return 'hardened_runtime_missing'
  return undefined
}
