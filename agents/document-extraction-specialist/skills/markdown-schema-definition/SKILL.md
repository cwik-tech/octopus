---
name: markdown-schema-definition
description: Markdown and provenance schema — define frontmatter structure, heading design, chunking hints, quality metadata, and versioning policy for knowledge base documents
---

# Markdown Schema Definition

## Purpose

Define the Markdown structure, frontmatter, chunking strategy, and provenance metadata that will be consistent across all parsed documents. This schema is permanent; get it right before parsing begins. Every field must serve the downstream retrieval, citation, and audit workflows.

## When to Use

- Before parser selection (schema design informs parser choice)
- Before building the parsing pipeline (schema drives implementation)
- When adding new metadata or versioning policy (with backward-compatibility plan)

## Frontmatter Structure

**Every parsed document must have frontmatter** in YAML format:

```yaml
---
# Source and versioning
source_id: "acme-spec-v2.3"  # Authoritative source identifier (e.g., SharePoint path, product ID)
source_uri: "https://sharepoint.company.com/sites/engineering/Documents/acme-spec.docx"
source_type: "docx"  # Original file format (pdf, docx, xlsx, etc.)
source_revision: "2.3"  # Source version/revision
source_hash: "sha256:a1b2c3d4..."  # Hash of original source for change detection

# Parsing metadata
parser: "openai_document_intelligence"  # Parser name and version
parser_version: "2024-08-01"
parse_timestamp: "2026-08-21T14:30:00Z"  # When parsing occurred
parse_run_id: "parse-2026-08-21-001"  # Unique identifier for this parse run

# Document metadata
title: "Acme Product Specification v2.3"
product_id: "ACME-100"  # Your internal product/process identifier
category: "product-specification"  # Document type (product-specification, sop, design-rule, etc.)
languages: ["en"]  # List of languages in document

# Access control
classification: "internal"  # internal, confidential, public, etc.
owner: "engineering@company.com"  # Owner contact or team
clearance_required: false  # Does reader need special clearance?

# Content quality
fidelity_score: 0.95  # Extraction fidelity (0–1): how much content was successfully extracted
ocr_confidence: 0.92  # Average OCR confidence if applicable (0–1)
multimodal_assets: true  # Does document include images, diagrams, tables that were extracted?
missing_content: []  # List of known issues (e.g., ["page 5 unreadable", "diagram A.2 not extracted"])

# Lifecycle
status: "current"  # current, superseded, draft, archived
effective_date: "2026-01-15"
expiry_date: null  # When this document becomes invalid/archived

# Retrieval hints
chunking_strategy: "section-based"  # How to chunk this document (section-based, page-based, etc.)
key_sections: ["Executive Summary", "Technical Specifications", "Parameter Table"]  # Main sections for retrieval
---
```

## Document Structure

**H1 (single):** Document title (should match `title` in frontmatter)

```markdown
# Acme Product Specification v2.3
```

**H2 (multiple):** Major sections

```markdown
## Executive Summary
## Technical Specifications
## Design Rules
## Parameter Reference
```

**H3/H4:** Subsections and sub-subsections (preserve nesting from original)

```markdown
### Mechanical Properties
#### Stress-Strain Behavior
```

**Heading naming:** Use the heading text from the source document. If headings are missing or vague, reconstruct them from content structure.

## Metadata in Content

**At the start of each major section, include a comment block with section-level metadata:**

```markdown
## Technical Specifications

<!-- section_id: tech-specs -->
<!-- section_sources: ["pages 3-7"] -->
<!-- contains_images: true -->
<!-- contains_tables: true -->
<!-- ocr_confidence: 0.94 -->
<!-- fidelity_issues: ["Table 2.1 merged cells, manual verification recommended"] -->

[Section content follows]
```

## Asset Referencing

**Images and diagrams:** Use standard Markdown image syntax with asset identifiers:

```markdown
![Material properties curve](assets/acme-spec-v2.3/figure-3-2.png)

[Figure 3.2 caption: Stress-strain curve for Acme Material X, showing yield stress 240 MPa, ultimate stress 310 MPa]
```

**Asset metadata:** Store a manifest alongside parsed documents:

```yaml
# assets-manifest.yml for acme-spec-v2.3
assets:
  - id: "figure-3-2.png"
    source: "page 5"
    size_bytes: 45000
    hash: "sha256:xyz..."
    type: "diagram"
    description: "Stress-strain curve showing yield and ultimate stress points"
    extracted_text: ["Yield: 240 MPa", "Ultimate: 310 MPa"]  # Extracted labels and values
```

## Chunking Hints

**Every major section should have a chunking hint comment:**

```markdown
## Design Rules

<!-- chunking_boundary: true -->
<!-- chunk_size_target: 1500 words -->
<!-- keep_together: ["section intro", "parameter tables", "examples"] -->
```

This guides the retrieval system on where to split sections into retrievable chunks.

## Quality and Provenance Fields

**Mark low-confidence content inline:**

```markdown
## Scanned Data

> ⚠️ **OCR Confidence: 87%** — This section was scanned. Manual review recommended for technical parameters.
> [Original PDF available: assets/scan-page-12.pdf]()

[OCR'd text follows]
```

**Table extraction quality notes:**

```markdown
| Parameter | Value | Unit | Note |
|-----------|-------|------|------|
| Max temp | 250 | °C | [*Merged cell in original; verified from p. 6*] |
```

## Versioning and Change Tracking

**Markdown version:** Include parse run in metadata

```yaml
parse_run_id: "parse-2026-08-21-001"
parse_timestamp: "2026-08-21T14:30:00Z"
```

**Change detection:** When a source is re-parsed:

1. Compare source hash (in frontmatter) to current source
2. If hash matches, skip re-parse (document unchanged)
3. If hash differs, re-parse and update Markdown
4. Archive prior Markdown version with timestamp

**Rollback:** Keep timestamped versions of Markdown so retrieval can point to specific version if source is updated.

## Example Document

```markdown
---
source_id: "acme-spec-v2.3"
source_uri: "https://sharepoint.company.com/sites/engineering/acme-spec.docx"
source_revision: "2.3"
parser: "openai_document_intelligence"
parser_version: "2024-08-01"
parse_timestamp: "2026-08-21T14:30:00Z"
title: "Acme Product Specification v2.3"
product_id: "ACME-100"
category: "product-specification"
languages: ["en"]
classification: "internal"
owner: "engineering@company.com"
fidelity_score: 0.94
ocr_confidence: 0.92
status: "current"
effective_date: "2026-01-15"
chunking_strategy: "section-based"
key_sections: ["Executive Summary", "Technical Specifications", "Design Rules"]
---

# Acme Product Specification v2.3

## Executive Summary

<!-- section_id: executive-summary -->
<!-- section_sources: ["page 1"] -->

Acme Material X is a high-temperature composite designed for aerospace applications.

## Technical Specifications

<!-- section_id: tech-specs -->
<!-- section_sources: ["pages 3-7"] -->
<!-- contains_tables: true -->
<!-- fidelity_issues: ["Table 2.1 merged cells, OCR confidence 88%, manual verification recommended"] -->

### Mechanical Properties

![Material properties curve](assets/acme-spec-v2.3/figure-3-2.png)

[Figure 3.2: Stress-strain curve for Acme Material X showing yield stress 240 MPa, ultimate stress 310 MPa, elongation 8.5%]

| Property | Value | Unit | Note |
|----------|-------|------|------|
| Yield Strength | 240 | MPa | At 0.2% offset |
| Ultimate Strength | 310 | MPa | |
| Elongation | 8.5 | % | [*OCR confidence 89%; verified from p. 4*] |

## Design Rules

<!-- chunking_boundary: true -->
<!-- chunk_size_target: 1500 words -->

Acme Material X must not be used above 250°C continuous operation.

[Sections continue with consistent frontmatter and metadata structure]
```

## Implementation Notes

1. **Validate frontmatter on ingestion:** Schema enforcement at parse time
2. **Automate metadata extraction:** Parser should populate parse_timestamp, parser_version, source_hash
3. **Monitor schema changes:** Document any schema updates and their backward compatibility
4. **Index on retrieval:** Frontmatter fields should be queryable (filter by classification, product_id, etc.)
5. **Audit trail:** All schema changes and version migrations are logged

## Output

A Markdown schema definition document with:

1. **Frontmatter template:** Complete YAML structure with all required fields
2. **Heading strategy:** How to organize and name sections
3. **Asset referencing:** Conventions for images, diagrams, file naming
4. **Chunking hints:** Guidelines for retrieval chunk boundaries
5. **Quality metadata:** How to mark low-confidence content inline
6. **Versioning strategy:** How to detect source changes and archive Markdown versions
7. **Example document:** A concrete parsed document showing the schema in use
8. **Validation rules:** Schema enforcement for parser output
