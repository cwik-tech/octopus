/**
 * AC15's failure-attribution rule.
 *
 * The canary runs a control arm and a journal arm as separate processes, so no
 * single arm can reach a verdict: only something holding both outcomes can.
 * The rule lives here as a pure function so it is provable without provider
 * spend, and so the live test reports its arm rather than reasoning about the
 * other.
 *
 * It is deliberately not biconditional. Two arms failing is not agreement, and
 * a control arm failing while the journal arm completes is a different question
 * rather than a pass.
 */

export type CanaryVerdict =
  | 'both-completed'
  | 'journal-implicated'
  | 'journal-exonerated'
  | 'undetermined-different-failures'
  | 'undetermined-control-failed'

export interface CanaryArmOutcome {
  readonly completed: boolean
  /**
   * How the arm failed, in whatever form the run reported it. Compared only
   * for equality, and only when both arms failed.
   */
  readonly failureSignature?: string
}

export interface CanaryAttribution {
  readonly verdict: CanaryVerdict
  readonly summary: string
}

/**
 * Narrow a recorded arm outcome that came from a file another process wrote.
 *
 * It is external input: malformed JSON, a truncated write, or a file from an
 * older shape must produce a diagnostic naming the arm and the problem, not an
 * uncaught `SyntaxError` from deep inside a live gate that has already spent
 * provider credit.
 */
export function parseArmOutcome(
  arm: 'control' | 'journal',
  raw: string,
): CanaryArmOutcome {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error(
      `The ${arm} arm outcome is not valid JSON: ${raw.slice(0, 120)}`,
    )
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error(`The ${arm} arm outcome is not an object.`)
  }
  const record: Record<string, unknown> = { ...parsed }
  const completed = record['completed']
  if (typeof completed !== 'boolean') {
    throw new Error(`The ${arm} arm outcome has no boolean 'completed'.`)
  }
  const signature = record['failureSignature']
  if (signature !== undefined && typeof signature !== 'string') {
    throw new Error(`The ${arm} arm outcome has a non-string 'failureSignature'.`)
  }
  if (!completed && signature === undefined) {
    throw new Error(
      `The ${arm} arm outcome reports a failure with no signature, so the arms cannot be compared.`,
    )
  }
  return {
    completed,
    ...(signature === undefined ? {} : { failureSignature: signature }),
  }
}

export function attributeCanaryOutcome(input: {
  readonly journal: CanaryArmOutcome
  readonly control: CanaryArmOutcome
}): CanaryAttribution {
  const { journal, control } = input

  if (journal.completed && control.completed) {
    return {
      verdict: 'both-completed',
      summary: 'Both arms completed. The journal did not prevent the workflow from working.',
    }
  }

  if (journal.completed && !control.completed) {
    return {
      verdict: 'undetermined-control-failed',
      summary:
        'Undetermined, and worth investigating: the journal arm completed while the control arm failed, ' +
        'and the control arm is supposed to be the simpler path.',
    }
  }

  if (!journal.completed && control.completed) {
    return {
      verdict: 'journal-implicated',
      summary:
        'The journal is implicated for that failure: the journal arm failed and the control arm completed.',
    }
  }

  // Both failed. Whether that exonerates the journal depends entirely on
  // whether it is the same failure — which is why the signature is compared
  // rather than the mere fact of failing.
  const sameFailure =
    journal.failureSignature !== undefined &&
    journal.failureSignature === control.failureSignature
  if (sameFailure) {
    return {
      verdict: 'journal-exonerated',
      summary:
        'The journal is exonerated for that failure: both arms failed the same way. ' +
        'It says nothing about any other failure.',
    }
  }
  return {
    verdict: 'undetermined-different-failures',
    summary:
      'Undetermined: both arms failed, but differently. Diagnose both before drawing any conclusion — ' +
      'two arms failing is not agreement.',
  }
}
