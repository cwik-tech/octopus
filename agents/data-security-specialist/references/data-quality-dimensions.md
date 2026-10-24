# Data Quality Dimensions

| Dimension | Question | Example executable evidence |
|---|---|---|
| Completeness | Are required records and values present? | Required-field ratio or source-to-target count reconciliation |
| Validity | Does data conform to its declared domain and format? | Schema, range, enumeration, or pattern validation |
| Accuracy | Does data represent the trusted real-world value? | Comparison with an authoritative reference or a clearly labeled proxy |
| Uniqueness | Are identities represented without unintended duplicates? | Duplicate rate over the declared business key and grain |
| Consistency | Do related values obey the same rules across fields or systems? | Cross-field invariant or cross-system reconciliation |
| Timeliness | Is data available within its useful time window? | Freshness or arrival-lag SLI against a stated target |
| Referential integrity | Do references point to valid records under the contract? | Orphan ratio with declared late-arrival handling |

## Rule minimum

Every rule needs a business expectation, population, exact calculation, observation window, threshold, severity, response, owner, evidence, version, and links to the dataset and contract.

## Accuracy caution

Plausibility, conformity, consistency, and anomaly detection can reveal suspicious values but do not prove accuracy without a trusted reference. Label such checks as accuracy proxies.
