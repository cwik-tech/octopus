export {
  assertEditorialProvenancePreserved,
  buildResearchPublicationAudit,
  isSourceSectionHeading,
  normalizeCitationUrl,
  parseResearchPublicationAudit,
  stripCitationUrls,
  summarizeEditorialProvenance,
  type EditorialProvenanceSummary,
} from '../domains/deep-research/deep-research-publication-audit.js'
export {
  canonicalizeResearchCitations,
  collectCitationUrls,
  type ResearchCitationCanonicalizationResult,
} from '../domains/deep-research/deep-research-citation-canonicalization.js'
