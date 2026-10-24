---
name: multimodal-extraction-design
description: Multimodal extraction strategy — design extraction approaches for tables, diagrams, scanned pages, images, and OCR, balancing fidelity, cost, and asset retention
---

# Multimodal Extraction Design

## Purpose

Design a coherent extraction strategy for mixed-media documents. Decide for each content type—tables, diagrams, scanned pages, images, multilingual text—whether to extract natively, fall back to OCR, generate descriptions, or retain the asset. Balance fidelity against cost and complexity.

## When to Use

- When designing the parsing pipeline strategy before parser selection
- When a chosen parser handles some content types poorly and you need a fallback strategy
- When defining what "complete extraction" means for your corpus

## Strategy Framework

For each content type, specify:

1. **Primary extraction method** (native, OCR, description, asset-only)
2. **Fallback method** (what happens if primary fails)
3. **Confidence thresholds** (when to escalate to manual review)
4. **Asset retention policy** (what to keep for audit and human fallback)
5. **Cost and latency implications**

## Content Types and Strategies

### Tables

**Native Extraction (first choice)**
- Parser extracts table structure (cells, headers, merged cells), outputs as Markdown table or structured JSON
- Fidelity: High for well-formed tables; degrades with merged cells, nested structures, or visual formatting carrying meaning

**Fallback: OCR + Layout Analysis**
- If native extraction fails or confidence is low, run OCR on table region and detect cell boundaries via layout analysis
- Fidelity: Medium; layout-dependent, prone to missed or duplicated cells

**Fallback: Asset + Description**
- If OCR confidence <threshold, retain the original table image and generate a text description ("Table 3.2: Five-row material properties table with columns for...")
- Fidelity: Low on content, high on discoverability

**Confidence thresholds:**
- Native extraction: Accept if parser reports high confidence OR manual spot-check on sample rows succeeds
- OCR + layout: Accept if OCR confidence >90% AND detected cells align with visual structure
- Escalate to manual review: If confidence <85% or cell count discrepancy >10%

**Decision:** For FST technical documents, prioritize native table extraction with OCR fallback for scanned tables. Retain original image for tables <threshold for human verification.

### Diagrams and Technical Drawings

**Native Extraction (first choice, if parser supports)**
- Parser extracts vector data (shapes, text, connections)
- Fidelity: High, but requires parser support and semantic tagging

**Fallback: Asset + Generated Description**
- Retain the original diagram image; generate a text description via vision model or domain expert review
- Example: "Figure 4.1: Three-box process flow: [Input] → [Processing Step A: Temperature 200°C, Pressure 50 bar] → [Output], with feedback loop to step A from quality check"
- Fidelity: High on searchability, medium on precision

**Fallback: Asset only**
- Retain the image; no text extraction or description
- Fidelity: Low on text search, high on visual preservation

**Confidence thresholds:**
- Native extraction: Accept if semantic tags are complete (all labels, connections, and legend elements present)
- Asset + description: Accept if description covers purpose, major components, and relationships
- Escalate: If diagram is critical to task (e.g., circuit diagram) and extraction is incomplete

**Decision:** For FST, apply asset + generated description for technical diagrams. Prioritize correctness of labels, parameter values, and relationships. Retain original image.

### Scanned Pages and OCR

**Primary: OCR with Layout Analysis**
- Run OCR on scanned regions; detect and preserve layout (columns, margins, spacing)
- Fidelity: Depends on scan quality (DPI, contrast, skew)

**Confidence thresholds:**
- OCR accuracy: Accept if character confidence >90% on average AND sample manual verification succeeds
- Layout: Accept if detected columns/regions align with visual structure
- Escalate to review: If confidence <85%, or if page contains low-contrast text, non-Latin scripts, or handwriting

**Quality gates:**
- Measure OCR accuracy on a per-page basis (confidence score per text block)
- Flag low-confidence regions for human review
- Retain the original scanned image for audit and fallback

**Decision:** For FST, OCR all scanned pages >threshold quality. Retain original for audit. Escalate low-confidence pages to review queue.

### Images and Figures

**Native: Retain the Image**
- Store the original image in the knowledge base
- Provide a file reference in the Markdown (e.g., `![Material property graph](assets/figure-3-2.png)`)
- Optionally generate a text description for search discoverability

**Fallback: Generated Description**
- If image contains text (labels, legends, axis values), extract via OCR or vision model
- Generate a caption: e.g., "Figure 2: Stress-strain curve for Aluminum 6061-T6, showing yield stress 240 MPa, ultimate stress 310 MPa"

**Confidence thresholds:**
- Accept asset + description if description captures numeric labels and relationships
- Escalate if image is critical to understanding and extraction is incomplete (e.g., missing axis values)

**Decision:** Retain all images; extract and index text and numeric labels where present. Store assets separately with integrity checks.

### Multilingual Content

**Primary: Language-aware OCR/Extraction**
- Use a parser or OCR engine that supports all languages in your corpus
- Maintain language tags in metadata (e.g., frontmatter `languages: [en, de, fr]`)

**Quality gates:**
- Verify OCR confidence separately per language (confidence thresholds may differ)
- Flag low-confidence regions regardless of language
- Retain original assets for audit

**Decision:** Support all languages present in FST corpus. Measure OCR confidence per language. Escalate if confidence falls below threshold in any language.

## Design the Fallback Strategy

For each content type, specify what happens at each confidence level:

| Content Type | High Confidence (>90%) | Medium (80–90%) | Low (<80%) |
|---|---|---|---|
| Table | Accept extracted Markdown | Retain image + description | Manual review |
| Diagram | Accept description | Retain image + description | Manual review |
| Scanned page | Accept OCR text | Accept + flag for QA | Manual review |
| Image | Accept image + metadata | Accept image + optional description | Accept image |
| Multilingual | Accept with language tag | Accept + flag quality issue | Manual review |

## Cost and Latency Considerations

**Native extraction:** Fast, cheap, but requires parser support
**OCR:** Moderate cost; slower; requires quality thresholds and escalation
**Generated descriptions:** Moderate-to-high cost (vision model calls); adds latency; improves discoverability
**Asset retention:** Small storage cost; no latency impact; critical for audit

Example cost model:
- Native table extraction: $0.001 per table, <1 sec
- OCR: $0.01 per page, 2–3 sec
- Generated description (vision API): $0.02 per image, 3–5 sec
- Asset storage: $0.001 per image per month (typical cloud pricing)

## Asset Retention Policy

**Always retain:**
- Original scanned pages (PDFs, images)
- Diagrams and technical drawings (PNG, SVG)
- Tables from complex layouts (original image + extracted Markdown)

**Reference in Markdown:**
- Use consistent naming: `assets/source-uuid/filename`
- Include file hash (SHA-256) for integrity verification
- Maintain parent-document reference (e.g., `source-id: acme-spec-v2.3`)

**Storage:**
- Store assets separately from Markdown (deduplication, versioning)
- Implement integrity checks on ingestion
- Retain originals indefinitely for audit; compress older versions

## Output

A multimodal extraction strategy document with:

1. **Content-type matrix:** For each type (tables, diagrams, scans, images, multilingual), specify primary method, fallback, confidence thresholds
2. **Fallback decision tree:** What happens at each confidence level
3. **Asset retention policy:** What to keep, where, how long, with file naming and referencing conventions
4. **Quality gates:** OCR confidence floors, layout accuracy, descriptor completeness
5. **Cost and latency model:** Per-content-type costs and timing implications
6. **Escalation criteria:** When to route content to manual review queue
7. **Examples:** Concrete examples of accepted vs escalated content for each type
