/**
 * Constants shared between the Deep Research provider fixture and the tests
 * that assert on its output. Kept side-effect free so specs can import it
 * without starting the fixture server.
 */

/** A citation the editorial draft invents and the evidence graph never saw. */
export const DEEP_RESEARCH_UNVALIDATED_URL =
  'https://unvalidated-mention.example/secondary'

/** Sentence carrying that citation, minus the URL the canonicalizer removes. */
export const DEEP_RESEARCH_UNVALIDATED_SENTENCE = 'A secondary mention appears at'
