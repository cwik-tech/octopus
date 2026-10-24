# Data Naming Conventions

## General rules

- Prefer stable business terms over source-system abbreviations.
- Use one term for one concept and define unavoidable synonyms in the glossary.
- Name datasets and fields for meaning, not for the current implementation step.
- Include units or currency where ambiguity is possible.
- Do not encode data type, environment, or mutable status into a durable business name unless the platform requires it.
- Reserve suffixes such as `_id`, `_at`, `_date`, `_count`, `_amount`, and `_flag` for their stated semantics and document local variants.

## Temporal fields

Distinguish event time, effective time, recorded time, ingestion time, and processing time. Use timezone-aware timestamps and state the time zone or UTC contract.

## Keys

Name natural business identifiers distinctly from generated surrogate keys. Do not use a display name as an identity unless the contract proves it is stable and unique.

## Boolean and absence

Use names that make true and false unambiguous. Define whether absence means unknown, not applicable, withheld, delayed, or missing in error; do not collapse these meanings silently.

## Review

Check names against the business glossary, source-to-target mapping, contract, model, quality rules, and catalog before release.
