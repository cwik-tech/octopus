import test from 'node:test'
import assert from 'node:assert/strict'
import * as fs from 'node:fs'
import * as path from 'node:path'

const repoRoot = process.cwd()

test('writer prompt requires canonical draft output instead of handoff wrappers', () => {
  const promptPath = path.join(repoRoot, 'agents', 'writer', 'writer.md')
  const prompt = fs.readFileSync(promptPath, 'utf8')

  assert.match(prompt, /Return only the deliverable document in markdown\./)
  assert.match(prompt, /Do not append a handoff note\./)
  assert.match(prompt, /Forbidden:/)
  assert.doesNotMatch(prompt, /The Writer's output is the document itself \(`\.docx`\), plus a handoff note:/)
})

test('writer prompt prefers qualitative rewrite over placeholders for ordinary public-company overviews', () => {
  const promptPath = path.join(repoRoot, 'agents', 'writer', 'writer.md')
  const prompt = fs.readFileSync(promptPath, 'utf8')

  assert.match(prompt, /rewrite unsupported metric-specific claims into qualitative statements instead of emitting placeholders/i)
  assert.match(prompt, /For ordinary public-company one-pagers, prefer a clean qualitative statement over a TODO/i)
  assert.match(prompt, /If an exact metric is optional, rewrite around it instead/i)
  assert.match(prompt, /flatten it into neutral descriptive language/i)
  assert.match(prompt, /Do not soften the same unsupported claim into adjacent unsourced performance language/i)
  assert.match(prompt, /Placeholders are not a historical log/i)
  assert.match(prompt, /Remove obsolete placeholder-log entries whenever the related claim has been rewritten/i)
  assert.match(prompt, /remove the entire `## Placeholders` section when it is no longer needed/i)
  assert.match(prompt, /Use the template's heading names verbatim; do not rename sections into alternatives from the brief/i)
})

test('brief-builder prompt requires brief-only output without runtime handoff chatter', () => {
  const promptPath = path.join(repoRoot, 'agents', 'brief-builder', 'brief-builder.md')
  const prompt = fs.readFileSync(promptPath, 'utf8')

  assert.match(prompt, /Your output must be the brief itself\./)
  assert.match(prompt, /The runtime owns stage state and artifact handling\./)
  assert.match(prompt, /Return only the structured writing brief in markdown\./)
  assert.match(prompt, /Forbidden:/)
  assert.match(prompt, /routing notes to the runtime or another agent/i)
})

test('live writing-team includes a dedicated company overview template', () => {
  const templatePath = path.join(repoRoot, 'teams', 'writing-team', 'templates', 'company-overview.md')
  const template = fs.readFileSync(templatePath, 'utf8')

  assert.match(template, /template_name:\s*company-overview/)
  assert.match(template, /document_type:\s*one-pager/)
  assert.match(template, /Do not introduce unresolved placeholders for optional enrichment data\./)
})

test('live writing-team includes a dedicated executive summary one-pager template', () => {
  const templatePath = path.join(repoRoot, 'teams', 'writing-team', 'templates', 'executive-summary.md')
  const template = fs.readFileSync(templatePath, 'utf8')

  assert.match(template, /template_name:\s*executive-summary/)
  assert.match(template, /document_type:\s*one-pager/)
  assert.match(template, /recommended_style_profile:\s*strategic-consulting/)
  assert.match(template, /sections_required:[\s\S]*Context/)
  assert.match(template, /sections_required:[\s\S]*Executive Summary/)
  assert.match(template, /sections_required:[\s\S]*Main Findings/)
  assert.match(template, /sections_required:[\s\S]*Recommended Next Steps/)
  assert.match(template, /sections_required:[\s\S]*Open Questions And Assumptions/)
  assert.match(template, /Prioritize direct answers, concrete implications, and decision-useful next steps over narrative recap\./)
})

test('brief-builder prompt downgrades URL body gaps to non-blocking when full analysis is present in input', () => {
  const promptPath = path.join(repoRoot, 'agents', 'brief-builder', 'brief-builder.md')
  const prompt = fs.readFileSync(promptPath, 'utf8')

  assert.match(prompt, /VERBATIM_URL_RULE:/i)
  assert.match(prompt, /treat the URL body content as SOFT \(non-blocking\)/i)
  assert.match(prompt, /Downgrade any URL-body gaps to soft gaps and set status READY/i)
  assert.match(prompt, /The analysis already in the input is the authoritative source/i)
})

test('brief-builder prompt prefers the executive summary template for synthesis one-pagers', () => {
  const promptPath = path.join(repoRoot, 'agents', 'brief-builder', 'brief-builder.md')
  const prompt = fs.readFileSync(promptPath, 'utf8')

  assert.match(prompt, /EXEC_SUMMARY_TEMPLATE_RULE: For requests to summarize a discussion, research artifact, workshop output, or analysis log into a one-pager, prefer the executive-summary template when available/i)
  assert.match(prompt, /EXEC_SUMMARY_GAP_RULE: For executive-summary synthesis tasks, an inferred reader is acceptable and should not become a blocking gap/i)
  assert.match(prompt, /STRATEGIC_REGISTER_RULE: For board summaries, strategy syntheses, executive decision one-pagers, and consultant-style recommendation documents, prefer the strategic-consulting profile when available/i)
  assert.match(prompt, /TEMPLATE_SECTION_FIDELITY: When a template is selected, section guidance must preserve the template's section names and order exactly/i)
  assert.match(prompt, /For strategy memos, board syntheses, executive summaries of analysis artifacts, and recommendation-oriented one-pagers, prefer `strategic-consulting` when available\./i)
  assert.match(prompt, /For one-page synthesis deliverables built from discussion artifacts or analysis notes, prefer the executive-summary template when available\./i)
})

test('live writing-team includes a strategic consulting profile for consultant-style business writing', () => {
  const profilePath = path.join(repoRoot, 'teams', 'writing-team', 'profiles', 'strategic-consulting.yaml')
  const profile = fs.readFileSync(profilePath, 'utf8')
  const writerPrompt = fs.readFileSync(path.join(repoRoot, 'agents', 'writer', 'writer.md'), 'utf8')

  assert.match(profile, /name:\s*strategic-consulting/)
  assert.match(profile, /tone:\s*strategic/)
  assert.match(profile, /lead-with-implication/)
  assert.match(profile, /Avoid chatty framing, rhetorical flourish, and casual labels\./)
  assert.match(writerPrompt, /When the active profile is strategy-oriented or consultant-style, do not slip into journalistic, chatty, or colorful phrasing/i)
  assert.match(writerPrompt, /When the profile is `strategic-consulting`, write in a professional advisory register/i)
})
