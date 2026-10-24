import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import XlsxPopulate from "xlsx-populate";

import { isPathInside } from "../../core/path-safety.js";
import { EXCEL_TEMPLATES_DIRECTORY } from "./generate-excel-types.js";
import type {
  ExcelTemplateCellInput,
  ExcelTemplateCellValue,
  ExcelTemplateData,
  ExcelTemplateManifest,
  ExcelTemplateTableColumn,
  ExcelTemplateTableInput,
  ExcelTemplateValueType,
  FillExcelTemplateResult,
  GenerateExcelTemplateSummary,
  LoadedExcelTemplate,
} from "./generate-excel-types.js";

const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const INPUT_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;
const A1_CELL_PATTERN = /^([A-Za-z]{1,3})([1-9]\d{0,6})$/;
const VALUE_TYPES: readonly ExcelTemplateValueType[] = [
  "string",
  "number",
  "percent",
  "date",
  "boolean",
];
const MAX_TEMPLATE_BYTES = 20 * 1_024 * 1_024;

export interface ListExcelTemplatesResult {
  readonly templates: readonly LoadedExcelTemplate[];
  readonly warnings: readonly string[];
}

/**
 * Locate the owned templates directory from source, packaged, and cwd
 * layouts; callers that know the repo root should pass it directly.
 */
export function resolveDefaultExcelTemplatesRoot(): string {
  const moduleDirectory = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.join(moduleDirectory, "templates"),
    path.resolve(
      moduleDirectory,
      "..",
      "..",
      "..",
      ...EXCEL_TEMPLATES_DIRECTORY.split("/"),
    ),
    path.resolve(process.cwd(), ...EXCEL_TEMPLATES_DIRECTORY.split("/")),
  ];
  const defaultCandidate = candidates[0]
  if (!defaultCandidate) throw new Error("Excel template search has no candidates.")
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? defaultCandidate;
}

export function listExcelTemplates(
  templatesRoot: string,
): ListExcelTemplatesResult {
  const root = path.resolve(templatesRoot);
  if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
    return { templates: [], warnings: [] };
  }
  const templates: LoadedExcelTemplate[] = [];
  const warnings: string[] = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      templates.push(loadExcelTemplate(root, entry.name));
    } catch (error) {
      warnings.push(
        `Excel template '${entry.name}' was skipped: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
  templates.sort((left, right) =>
    left.manifest.id.localeCompare(right.manifest.id),
  );
  return { templates, warnings };
}

export function loadExcelTemplate(
  templatesRoot: string,
  templateId: string,
): LoadedExcelTemplate {
  if (!TEMPLATE_ID_PATTERN.test(templateId)) {
    throw new Error(`Excel template id '${templateId}' is invalid.`);
  }
  const templateDirectory = path.resolve(templatesRoot, templateId);
  const manifestPath = path.join(templateDirectory, "manifest.json");
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Excel template '${templateId}' has no manifest.json.`);
  }
  const manifest = validateManifest(templateId, readJson(manifestPath));
  const templatePath = path.resolve(templateDirectory, manifest.templateFile);
  if (!isPathInside(templateDirectory, templatePath)) {
    throw new Error(
      `Excel template '${templateId}' references a template file outside its directory.`,
    );
  }
  const stats = fs.existsSync(templatePath)
    ? fs.statSync(templatePath)
    : undefined;
  if (!stats?.isFile()) {
    throw new Error(
      `Excel template '${templateId}' is missing its workbook file '${manifest.templateFile}'.`,
    );
  }
  if (stats.size > MAX_TEMPLATE_BYTES) {
    throw new Error(
      `Excel template '${templateId}' exceeds the 20 MB size limit.`,
    );
  }
  return { manifest, templatePath };
}

export function excelTemplateSummary(
  template: LoadedExcelTemplate,
): GenerateExcelTemplateSummary {
  const { manifest } = template;
  return {
    id: manifest.id,
    displayName: manifest.displayName,
    description: manifest.description,
    cells: Object.entries(manifest.inputs.cells ?? {}).map(([name, input]) => ({
      name,
      type: input.type,
      required: input.required === true,
      ...(input.description ? { description: input.description } : {}),
    })),
    tables: Object.entries(manifest.inputs.tables ?? {}).map(
      ([name, input]) => ({
        name,
        columns: input.columns,
        ...(input.maxRows !== undefined ? { maxRows: input.maxRows } : {}),
        ...(input.description ? { description: input.description } : {}),
      }),
    ),
  };
}

/**
 * Parse untrusted JSON into template data. Only plain objects with
 * string/number/boolean leaf values are accepted.
 */
export function parseExcelTemplateData(raw: unknown): ExcelTemplateData {
  if (!isPlainObject(raw)) {
    throw new Error(
      "Template data must be a JSON object with optional cells and tables.",
    );
  }
  const allowedKeys = new Set(["cells", "tables"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      throw new Error(
        `Template data key '${key}' is not supported; use cells and tables.`,
      );
    }
  }
  const cells: Record<string, ExcelTemplateCellValue> = {};
  if (raw.cells !== undefined) {
    if (!isPlainObject(raw.cells))
      throw new Error("Template data cells must be an object.");
    for (const [name, value] of Object.entries(raw.cells)) {
      if (!isCellValue(value)) {
        throw new Error(
          `Template data cell '${name}' must be a string, number, or boolean.`,
        );
      }
      cells[name] = value;
    }
  }
  const tables: Record<
    string,
    Readonly<Record<string, ExcelTemplateCellValue>>[]
  > = {};
  if (raw.tables !== undefined) {
    if (!isPlainObject(raw.tables))
      throw new Error("Template data tables must be an object.");
    for (const [name, rowsValue] of Object.entries(raw.tables)) {
      if (!Array.isArray(rowsValue)) {
        throw new Error(
          `Template data table '${name}' must be an array of row objects.`,
        );
      }
      const rows: Readonly<Record<string, ExcelTemplateCellValue>>[] = [];
      for (const rowValue of rowsValue) {
        if (!isPlainObject(rowValue)) {
          throw new Error(
            `Template data table '${name}' must contain only row objects.`,
          );
        }
        const row: Record<string, ExcelTemplateCellValue> = {};
        for (const [key, value] of Object.entries(rowValue)) {
          if (!isCellValue(value)) {
            throw new Error(
              `Template data table '${name}' column '${key}' must be a string, number, or boolean.`,
            );
          }
          row[key] = value;
        }
        rows.push(row);
      }
      tables[name] = rows;
    }
  }
  return { cells, tables };
}

/**
 * Fill a template workbook with data. The workbook is edited in place by
 * xlsx-populate, so charts, pivot tables, formulas, and formatting that the
 * data does not touch survive unchanged.
 */
export async function fillExcelTemplate(
  template: LoadedExcelTemplate,
  data: ExcelTemplateData,
  signal?: AbortSignal,
): Promise<FillExcelTemplateResult> {
  if (signal?.aborted) throw abortError();
  const { manifest } = template;
  const warnings: string[] = [];
  const errors: string[] = [];

  const cellInputs = manifest.inputs.cells ?? {};
  const tableInputs = manifest.inputs.tables ?? {};
  for (const name of Object.keys(data.cells ?? {})) {
    if (!cellInputs[name])
      warnings.push(
        `Template data cell '${name}' is not declared by the template and was ignored.`,
      );
  }
  for (const name of Object.keys(data.tables ?? {})) {
    if (!tableInputs[name])
      warnings.push(
        `Template data table '${name}' is not declared by the template and was ignored.`,
      );
  }
  for (const [name, input] of Object.entries(cellInputs)) {
    if (input.required === true && data.cells?.[name] === undefined) {
      errors.push(`Required template cell '${name}' is missing from the data.`);
    }
  }
  if (errors.length > 0) throw new Error(errors.join(" "));

  const workbook = await XlsxPopulate.fromDataAsync(
    fs.readFileSync(template.templatePath),
  );
  if (signal?.aborted) throw abortError();

  for (const [name, input] of Object.entries(cellInputs)) {
    const rawValue = data.cells?.[name];
    if (rawValue === undefined) continue;
    const value = convertValue(rawValue, input.type, `cell '${name}'`);
    if (input.range) {
      const target = workbook.definedName(input.range);
      if (!target) {
        throw new Error(
          `Template defined name '${input.range}' for cell '${name}' does not exist in the workbook.`,
        );
      }
      if ("startCell" in target) {
        target.startCell().value(value);
      } else {
        target.value(value);
      }
      continue;
    }
    const sheet = workbook.sheet(input.sheet ?? "");
    if (!sheet) {
      throw new Error(
        `Template sheet '${input.sheet}' for cell '${name}' does not exist in the workbook.`,
      );
    }
    sheet.cell(input.cell ?? "").value(value);
  }

  for (const [name, input] of Object.entries(tableInputs)) {
    if (signal?.aborted) throw abortError();
    const sheet = workbook.sheet(input.sheet);
    if (!sheet) {
      throw new Error(
        `Template sheet '${input.sheet}' for table '${name}' does not exist in the workbook.`,
      );
    }
    const start = parseA1Cell(input.startCell);
    let rows = data.tables?.[name] ?? [];
    if (input.maxRows !== undefined && rows.length > input.maxRows) {
      warnings.push(
        `Template table '${name}' accepts ${input.maxRows} rows; ${rows.length - input.maxRows} extra rows were dropped.`,
      );
      rows = rows.slice(0, input.maxRows);
    }
    const declaredKeys = new Set(input.columns.map((column) => column.key));
    const unknownKeys = new Set<string>();
    rows.forEach((row, rowIndex) => {
      for (const key of Object.keys(row)) {
        if (!declaredKeys.has(key)) unknownKeys.add(key);
      }
      input.columns.forEach((column, columnIndex) => {
        const rawValue = row[column.key];
        const value =
          rawValue === undefined
            ? undefined
            : convertValue(
                rawValue,
                column.type,
                `table '${name}' column '${column.key}'`,
              );
        sheet
          .cell(start.row + rowIndex, start.column + columnIndex)
          .value(value);
      });
    });
    if (unknownKeys.size > 0) {
      warnings.push(
        `Template table '${name}' received undeclared columns that were ignored: ${[...unknownKeys].join(", ")}.`,
      );
    }
    const clearUntil = input.maxRows ?? rows.length;
    for (let rowIndex = rows.length; rowIndex < clearUntil; rowIndex += 1) {
      input.columns.forEach((_column, columnIndex) => {
        sheet
          .cell(start.row + rowIndex, start.column + columnIndex)
          .value(undefined);
      });
    }
  }

  if (signal?.aborted) throw abortError();
  return { buffer: await workbook.outputAsync(), warnings };
}

function convertValue(
  value: ExcelTemplateCellValue,
  type: ExcelTemplateValueType,
  label: string,
): unknown {
  switch (type) {
    case "string":
      return String(value);
    case "number":
    case "percent": {
      const parsed = typeof value === "number" ? value : Number(value);
      if (typeof value === "boolean" || !Number.isFinite(parsed)) {
        throw new Error(
          `Template ${label} expects a number, received '${String(value)}'.`,
        );
      }
      return parsed;
    }
    case "date": {
      const date =
        typeof value === "string" || typeof value === "number"
          ? new Date(typeof value === "string" ? `${value}T00:00:00Z` : value)
          : undefined;
      if (!date || Number.isNaN(date.getTime())) {
        throw new Error(
          `Template ${label} expects an ISO date (yyyy-mm-dd), received '${String(value)}'.`,
        );
      }
      return XlsxPopulate.dateToNumber(date);
    }
    case "boolean": {
      if (typeof value === "boolean") return value;
      if (value === "true" || value === "false") return value === "true";
      throw new Error(
        `Template ${label} expects a boolean, received '${String(value)}'.`,
      );
    }
  }
}

function parseA1Cell(address: string): { row: number; column: number } {
  const match = address.match(A1_CELL_PATTERN);
  if (!match)
    throw new Error(`Cell address '${address}' is not a valid A1 reference.`);
  const letters = match[1];
  const row = match[2];
  if (!letters || !row) throw new Error(`Cell address '${address}' is not a valid A1 reference.`);
  const normalizedLetters = letters.toUpperCase();
  let column = 0;
  for (const letter of normalizedLetters) {
    column = column * 26 + (letter.charCodeAt(0) - 64);
  }
  return { row: Number(row), column };
}

function validateManifest(
  templateId: string,
  raw: unknown,
): ExcelTemplateManifest {
  if (!isPlainObject(raw)) {
    throw new Error("manifest.json must be a JSON object.");
  }
  if (raw.id !== templateId) {
    throw new Error(
      `manifest id '${String(raw.id)}' must match the directory name '${templateId}'.`,
    );
  }
  if (
    !nonEmpty(raw.displayName) ||
    !nonEmpty(raw.description) ||
    !nonEmpty(raw.templateFile) ||
    !raw.templateFile.toLowerCase().endsWith(".xlsx") ||
    path.isAbsolute(raw.templateFile) ||
    !isPlainObject(raw.inputs)
  ) {
    throw new Error(
      "manifest.json is missing displayName, description, templateFile (.xlsx), or inputs.",
    );
  }
  const cells = raw.inputs.cells ?? {};
  const tables = raw.inputs.tables ?? {};
  if (!isPlainObject(cells) || !isPlainObject(tables)) {
    throw new Error("manifest inputs.cells and inputs.tables must be objects.");
  }
  if (Object.keys(cells).length === 0 && Object.keys(tables).length === 0) {
    throw new Error("manifest must declare at least one cell or table input.");
  }
  return {
    id: raw.id,
    displayName: raw.displayName,
    description: raw.description,
    templateFile: raw.templateFile,
    inputs: {
      ...(Object.keys(cells).length === 0
        ? {}
        : {
            cells: Object.fromEntries(
              Object.entries(cells).map(([name, input]) => [
                name,
                parseCellInput(name, input),
              ]),
            ),
          }),
      ...(Object.keys(tables).length === 0
        ? {}
        : {
            tables: Object.fromEntries(
              Object.entries(tables).map(([name, input]) => [
                name,
                parseTableInput(name, input),
              ]),
            ),
          }),
    },
  };
}

function parseCellInput(name: string, value: unknown): ExcelTemplateCellInput {
  if (!isPlainObject(value))
    throw new Error(`cell input '${name}' is invalid.`);
  const input = value;
  if (!INPUT_NAME_PATTERN.test(name)) {
    throw new Error(`cell input name '${name}' is invalid.`);
  }
  if (!VALUE_TYPES.some((valueType) => valueType === input.type)) {
    throw new Error(
      `cell input '${name}' has an unsupported type '${String(input.type)}'.`,
    );
  }
  const hasRange = nonEmpty(input.range);
  const hasAddress = nonEmpty(input.sheet) && nonEmpty(input.cell);
  if (hasRange === hasAddress) {
    throw new Error(
      `cell input '${name}' must set either a defined-name range or a sheet plus cell address.`,
    );
  }
  const cell = hasAddress
    ? requiredText(input.cell, `cell input '${name}' cell`)
    : undefined;
  if (cell !== undefined && !A1_CELL_PATTERN.test(cell)) {
    throw new Error(
      `cell input '${name}' has an invalid A1 address '${String(input.cell)}'.`,
    );
  }
  return {
    type: parseValueType(input.type),
    ...(input.required === undefined
      ? {}
      : {
          required: requiredBoolean(
            input.required,
            `cell input '${name}' required`,
          ),
        }),
    ...(input.description === undefined
      ? {}
      : {
          description: requiredText(
            input.description,
            `cell input '${name}' description`,
          ),
        }),
    ...(input.range === undefined
      ? {}
      : { range: requiredText(input.range, `cell input '${name}' range`) }),
    ...(input.sheet === undefined
      ? {}
      : { sheet: requiredText(input.sheet, `cell input '${name}' sheet`) }),
    ...(cell === undefined ? {} : { cell }),
  };
}

function parseTableInput(
  name: string,
  value: unknown,
): ExcelTemplateTableInput {
  if (!isPlainObject(value))
    throw new Error(`table input '${name}' is invalid.`);
  const input = value;
  if (!INPUT_NAME_PATTERN.test(name)) {
    throw new Error(`table input name '${name}' is invalid.`);
  }
  const sheet = requiredText(input.sheet, `table input '${name}' sheet`);
  const startCell = requiredText(
    input.startCell,
    `table input '${name}' startCell`,
  );
  if (!A1_CELL_PATTERN.test(startCell)) {
    throw new Error(
      `table input '${name}' needs a sheet and a valid A1 startCell.`,
    );
  }
  if (!Array.isArray(input.columns) || input.columns.length === 0) {
    throw new Error(`table input '${name}' must declare at least one column.`);
  }
  const seen = new Set<string>();
  const columns: ExcelTemplateTableColumn[] = [];
  for (const column of input.columns) {
    if (
      !isPlainObject(column) ||
      !nonEmpty(column.key) ||
      !VALUE_TYPES.some((valueType) => valueType === column.type)
    ) {
      throw new Error(
        `table input '${name}' has an invalid column definition.`,
      );
    }
    if (seen.has(column.key)) {
      throw new Error(
        `table input '${name}' declares column '${column.key}' twice.`,
      );
    }
    seen.add(column.key);
    columns.push({
      key: column.key,
      type: parseValueType(column.type),
      ...(column.description === undefined
        ? {}
        : {
            description: requiredText(
              column.description,
              `table input '${name}' column description`,
            ),
          }),
    });
  }
  const maxRows =
    input.maxRows === undefined
      ? undefined
      : requiredPositiveMaxRows(input.maxRows, name);
  if (maxRows !== undefined && maxRows > 100_000) {
    throw new Error(`table input '${name}' has an invalid maxRows value.`);
  }
  return {
    sheet,
    startCell,
    columns,
    ...(input.description === undefined
      ? {}
      : {
          description: requiredText(
            input.description,
            `table input '${name}' description`,
          ),
        }),
    ...(maxRows === undefined ? {} : { maxRows }),
  };
}

function parseValueType(value: unknown): ExcelTemplateValueType {
  if (
    value === "string" ||
    value === "number" ||
    value === "percent" ||
    value === "date" ||
    value === "boolean"
  )
    return value;
  throw new Error(`Excel input type '${String(value)}' is unsupported.`);
}

function requiredText(value: unknown, label: string): string {
  if (!nonEmpty(value)) throw new Error(`${label} must be non-empty.`);
  return value;
}

function requiredBoolean(value: unknown, label: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${label} must be boolean.`);
  return value;
}

function requiredPositiveMaxRows(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new Error(`table input '${name}' has an invalid maxRows value.`);
  }
  return value;
}

function readJson(filePath: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    throw new Error(
      `Cannot read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isCellValue(value: unknown): value is ExcelTemplateCellValue {
  return (
    typeof value === "string" ||
    (typeof value === "number" && Number.isFinite(value)) ||
    typeof value === "boolean"
  );
}

function nonEmpty(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function abortError(): Error {
  const error = new Error("Excel template filling was cancelled.");
  error.name = "AbortError";
  return error;
}
