export type FileSourceParseStatus =
  | "pending"
  | "parsing"
  | "parsed"
  | "error";

export interface FileSourceRecord {
  name: string;
  size: number;
  uploadedAt: string;
  usedAt?: string;
  parseStatus: FileSourceParseStatus;
  parsedAt?: string;
  parserError?: string;
  outputs?: Record<string, string>;
}

export interface FileSourceManifestFile {
  source: string;
  status: "success" | "error";
  error?: string;
  outputs?: Record<string, string>;
  [key: string]: unknown;
}

export interface FileSourceManifest<
  TFile extends FileSourceManifestFile = FileSourceManifestFile,
> {
  generated_at?: string;
  files: TFile[];
  [key: string]: unknown;
}

export interface FileSourceSnapshot<
  TFile extends FileSourceManifestFile = FileSourceManifestFile,
> {
  files: FileSourceRecord[];
  manifest: FileSourceManifest<TFile> | null;
}

export type FileSourceSaveResult =
  | { status: "saved"; file: FileSourceRecord }
  | { status: "duplicate_file" }
  | { status: "invalid_path" };

export type FileSourceTargetStatus =
  | "available"
  | "duplicate_file"
  | "invalid_path";

export type FileSourceDeleteResult = "deleted" | "not_found" | "locked";
