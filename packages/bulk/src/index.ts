// @cnote/bulk — seller bulk import (CSV / XLSX / ZIP with images) and export.
// PUBLIC CONTRACT. Files live in object storage; rows are processed by queue consumers (see `worker`).
// Imports only ever write the seller's working copy through @cnote/catalogue: nothing reaches buyers without the
// normal version review, and uploaded images are approved by staff.
import "./types";

export { LIMITS, type BulkActor, type BulkJobView, type BulkJobStatusName, type FileFormat, type ImportMode, type ImportOptions, type RawRow, type RowError } from "./types";
export { buildImportTemplate, buildStarterKit, placeholderPng, type TemplateOptions } from "./template";
export { detectFormat, parseImportFile, parseCsvBytes, parseXlsxBytes, parseZipBytes, type ParsedImport, type ParsedImage } from "./parse";
export { validateRows, rupeesToPaise, resolveImage, type ImportVariant, type ImportRow, type ValidationContext, type ValidationResult } from "./validate";
export { buildErrorReport } from "./report";
export { columnsFor, variantColumns, parseAvailability, normalizeHeader, isExampleSku, BASE_COLUMNS, UNITS, LANGUAGES, type Column } from "./columns";
export {
  createImportJob, confirmImportJob, cancelJob, getJob, listJobs, createExportJob, getDownload, purgeExpiredJobs, buildExport,
  validateImportJob, runImportJob, runExportJob, type BulkDownload,
} from "./jobs";
export { setBulkStore, getBulkStore, MemoryBulkStore, type BulkStore } from "./store";
export { worker } from "./worker";
