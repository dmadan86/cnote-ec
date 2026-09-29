export * from "./types";
export { getSearchIndex, searchBackendName, setSearchIndexForTests } from "./factory";
export { OpenSearchIndex, createOpenSearchClient, type OsClient } from "./opensearch";
export { postgresIndex } from "./postgres";
