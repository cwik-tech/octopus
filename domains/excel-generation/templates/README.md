# Excel Templates

Curated `.xlsx` workbook templates for the Generate Excel capability. A
template guarantees that a recurring deliverable (a weekly risk register, a
DCF model, a scorecard) is byte-for-byte the same workbook every time: layout,
formatting, charts, and formulas live in the template file, and agents supply
only the data.

## Layout

Each template is a directory named after its id:

```
domains/excel-generation/templates/
  risk-register/
    manifest.json
    template.xlsx
```

- `template.xlsx` — the workbook, authored in Excel. Anything the data does
  not touch (formulas, charts, pivot tables, formatting) survives filling
  unchanged because the engine edits the file in place.
- `manifest.json` — declares the data the template accepts. Agents call
  `generate_excel` with `action: list_templates` to read these declarations
  and produce a matching JSON data artifact.

## Manifest format

```json
{
  "id": "dcf-model",
  "displayName": "DCF Model",
  "description": "Discounted cash flow model; NPV and IRR are template formulas.",
  "templateFile": "template.xlsx",
  "inputs": {
    "cells": {
      "company_name": {
        "type": "string",
        "required": true,
        "range": "CompanyName"
      },
      "discount_rate": { "type": "percent", "sheet": "Model", "cell": "B2" }
    },
    "tables": {
      "cash_flows": {
        "sheet": "Model",
        "startCell": "A5",
        "maxRows": 50,
        "columns": [
          { "key": "year", "type": "number" },
          { "key": "amount", "type": "number" }
        ]
      }
    }
  }
}
```

- `id` must match the directory name.
- A cell input targets either a workbook defined name (`range`) or a
  `sheet` plus A1 `cell` address. Types: `string`, `number`, `percent`
  (fraction, e.g. `0.18`), `date` (ISO `yyyy-mm-dd`), `boolean`.
- A table input fills consecutive rows starting at `startCell`, one column per
  declared key. Rows beyond `maxRows` are dropped with a warning; unused rows
  inside the region are cleared so stale sample data never leaks into output.

## Data artifact

The agent (or workflow step) provides JSON shaped like:

```json
{
  "cells": { "company_name": "Acme Robotics", "discount_rate": 0.18 },
  "tables": {
    "cash_flows": [
      { "year": 2026, "amount": 1200000 }
    ]
  }
}
```

## Shipped templates

- `risk-register` — the weekly risk assessment workbook ("Risk template v1").
  One table input (`risks`, up to 83 rows) starting at `Risks!B2` so the
  numbering formulas in column A and the entire formula-driven Risk summary
  sheet stay intact. See its `manifest.json` for the exact columns and the
  allowed list values (likelihood, severity, category, status, owner).

Fill it via any entry point:

- Agent tool: `generate_excel` with `action: fill_template`
- Workflow step: `transform: generate_excel` with `excel: { template: risk-register }`
- CLI: `npm run generate:excel -- data.json out.xlsx --template risk-register`

Keep derived figures (totals, NPV, scores) as formulas in the template —
never supply them as data.
