// Shared types + limits for seller bulk import / export.

export const LIMITS = {
  maxRows: 5_000,
  /** plain CSV / XLSX upload */
  maxSheetBytes: 50 * 1024 * 1024,
  maxZipCompressedBytes: 200 * 1024 * 1024,
  maxZipUncompressedBytes: 500 * 1024 * 1024,
  maxZipFiles: 2_000,
  /** an .xlsx is a zip: cap what it may inflate to and how many parts it has (zip-bomb guard) */
  maxXlsxUncompressedBytes: 200 * 1024 * 1024,
  maxXlsxEntries: 1_000,
  maxColumns: 200,
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerRow: 8,
  /** files below this many rows are validated inline; larger ones go through the "bulk.validate" queue */
  syncValidateRows: 500,
  batchSize: 50,
  retentionDays: 7,
  importsPerHour: 10,
  exportsPerHour: 20,
  sampleErrors: 50,
} as const;

export type ImportMode = "create" | "upsert";
export type FileFormat = "csv" | "xlsx" | "zip";

export interface ImportOptions {
  mode: ImportMode;
  /** submit each imported listing for review (nothing goes live without review either way) */
  submitForReview: boolean;
  /** set at confirm time: import the valid rows even though some rows have errors */
  skipInvalid?: boolean;
}

export interface RowError {
  /** spreadsheet row number (header = 1); 0 = whole file */
  row: number;
  /** column header key, or "" for row-level problems */
  column: string;
  message: string;
}

/** One data row as read from the sheet: normalised header -> trimmed text. */
export interface RawRow {
  row: number;
  cells: Record<string, string>;
}

export interface BulkActor {
  personId: string;
  businessId: string;
}

export type BulkJobStatusName =
  | "uploaded" | "validating" | "validated" | "queued" | "processing"
  | "completed" | "completed_with_errors" | "failed" | "cancelled" | "expired";

export interface BulkJobView {
  id: string;
  kind: "import" | "export";
  status: BulkJobStatusName;
  format: string;
  originalName: string | null;
  options: Partial<ImportOptions> & { includeImages?: boolean; exportFormat?: "csv" | "xlsx" };
  totalRows: number;
  processedRows: number;
  createdCount: number;
  updatedCount: number;
  errorCount: number;
  imageCount: number;
  sampleErrors: RowError[];
  lastError: string | null;
  hasSource: boolean;
  hasResult: boolean;
  hasErrorReport: boolean;
  /** true while the job is doing work or waiting on the worker */
  active: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  expiresAt: string | null;
}

declare module "@cnote/core" {
  interface JobTopics {
    /** Parse + dry-run validate an uploaded import file (large files). Idempotent. */
    "bulk.validate": { jobId: string };
    /** Import the validated rows in batches; resumable via the processed-row checkpoint. */
    "bulk.import": { jobId: string };
    /** Build a seller's export file. Idempotent. */
    "bulk.export": { jobId: string };
  }
}
