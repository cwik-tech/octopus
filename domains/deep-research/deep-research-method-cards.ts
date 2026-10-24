import {
  DEEP_RESEARCH_METHOD_CARD_IDS,
  type ResearchLens,
  type ResearchMethodCardId,
  type ResearchSourceType,
} from '../../contracts/deep-research.js'

export interface ResearchMethodCard {
  readonly id: ResearchMethodCardId
  readonly version: 1
  readonly name: string
  readonly lenses: readonly ResearchLens[]
  readonly procedure: readonly string[]
  readonly preferredSourceTypes: readonly ResearchSourceType[]
  readonly requiredChecks: readonly string[]
  readonly failureModes: readonly string[]
}

const METHOD_CARDS = [
  card('general-research-v1', 'General research', ['foundational'],
    ['Define the answer boundary.', 'Collect direct evidence before interpreting it.', 'Record gaps and counterevidence.'],
    ['primary', 'secondary'], ['Trace every factual claim to an observed source.'],
    ['Treating search snippets or repeated publishers as corroboration.']),
  card('domain-bootstrap-v1', 'Domain bootstrap', ['foundational'],
    ['Identify domain vocabulary and authorities.', 'Map source hierarchy and disputed concepts.', 'Build a sourced provisional domain card.'],
    ['primary', 'regulatory', 'academic'], ['Separate guidance from evidence.'],
    ['Encoding unsourced model knowledge as domain facts.']),
  card('competitive-map-v1', 'Competitive map', ['competitive'],
    ['Define the comparison set.', 'Use the same dimensions for each subject.', 'Seek disconfirming evidence for rankings.'],
    ['primary', 'industry', 'news'], ['Corroborate comparative claims independently.'],
    ['Comparing vendor claims measured with different definitions.']),
  card('marketing-channel-analysis-v1', 'Marketing channel analysis', ['market'],
    ['Trace channel reach to conversion and economics.', 'Separate reported outcomes from attribution claims.', 'Compare evidence across channel owners.'],
    ['primary', 'industry', 'secondary'], ['Capture CAC, conversion, payback, and measurement window when available.'],
    ['Equating attention or engagement with profitable acquisition.']),
  card('customer-segmentation-v1', 'Customer segmentation', ['market'],
    ['Define segmentation variables.', 'Distinguish observed behavior from personas.', 'Test whether segments change the decision.'],
    ['primary', 'academic', 'industry'], ['Record population, sample, geography, and date.'],
    ['Treating anecdotal users as a representative segment.']),
  card('pricing-analysis-v1', 'Pricing analysis', ['market', 'competitive'],
    ['Capture current price and packaging from direct sources.', 'Normalize units and contract assumptions.', 'Separate list price from realized economics.'],
    ['primary', 'industry'], ['Record currency, date, unit, tier, and exclusions.'],
    ['Comparing unlike tiers or outdated price pages.']),
  card('regulatory-scan-v1', 'Regulatory scan', ['regulatory'],
    ['Fix jurisdiction and effective date.', 'Start with issuing authorities and primary law.', 'Separate binding rules from guidance.'],
    ['regulatory', 'primary'], ['Record authority, jurisdiction, status, and effective date.'],
    ['Generalizing one jurisdiction or nonbinding guidance.']),
  card('technical-evaluation-v1', 'Technical evaluation', ['technical'],
    ['Define measurable requirements.', 'Prefer official specifications and reproducible evidence.', 'Record version and operating constraints.'],
    ['primary', 'academic', 'industry'], ['Distinguish measured results from architectural inference.'],
    ['Comparing benchmarks with incompatible environments.']),
  card('source-verification-v1', 'Source verification', ['source_verification'],
    ['Open the underlying source.', 'Verify publisher, date, scope, and quoted context.', 'Check independent corroboration where required.'],
    ['primary', 'regulatory', 'academic', 'secondary'], ['Reject inaccessible or unobserved evidence.'],
    ['Citing an aggregator, snippet, or copied article as the original.']),
] as const satisfies readonly ResearchMethodCard[]

export const RESEARCH_METHOD_CARD_IDS = Object.freeze(
  [...DEEP_RESEARCH_METHOD_CARD_IDS],
)

const METHOD_CARD_BY_ID = new Map<string, ResearchMethodCard>(
  METHOD_CARDS.map((methodCard) => [methodCard.id, methodCard]),
)

export function listResearchMethodCards(): readonly ResearchMethodCard[] {
  return METHOD_CARDS
}

export function resolveResearchMethodCards(
  methodCardIds: readonly string[],
): readonly ResearchMethodCard[] {
  const cards = methodCardIds.map((id) => METHOD_CARD_BY_ID.get(id))
  const unknownIndex = cards.findIndex((entry) => !entry)
  if (unknownIndex >= 0) {
    throw new Error(
      `Worker specification references an unknown method card at index ${unknownIndex}.`,
    )
  }
  return cards as readonly ResearchMethodCard[]
}

function card(
  id: ResearchMethodCardId,
  name: string,
  lenses: readonly ResearchLens[],
  procedure: readonly string[],
  preferredSourceTypes: readonly ResearchSourceType[],
  requiredChecks: readonly string[],
  failureModes: readonly string[],
): ResearchMethodCard {
  return Object.freeze({
    id,
    version: 1 as const,
    name,
    lenses,
    procedure,
    preferredSourceTypes,
    requiredChecks,
    failureModes,
  })
}
