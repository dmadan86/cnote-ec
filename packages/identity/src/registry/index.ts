// Udyam + MCA registry verification (ADR-003 T1). Sub-module of @cnote/identity.
export { addressSimilarity, nameSimilarity, ADDRESS_PASS, ADDRESS_REVIEW, type AddressParts } from "./match";
export {
  UDYAM_RE, getUdyamProvider, getMcaProvider, setUdyamProvider, setMcaProvider, mockUdyamProvider, mockMcaProvider, createMockUdyamProvider, createMockMcaProvider,
  surepassUdyamProvider, surepassMcaProvider, parseSurepassUdyam, parseSurepassMca,
  type UdyamProvider, type McaProvider, type UdyamRecord, type McaRecord, type UdyamStatus, type McaStatus, type RegistryLookupOpts, type MockUdyamProvider, type MockMcaProvider,
} from "./providers";
export {
  verifyRegistry, verifyUdyam, verifyMca, evaluateRegistryChecks, isValidRegistryNumber, listPendingRegistryReviews, resolveRegistryReview, recheckRegistry, runRegistryRecheck, registryWorkerJobs, REGISTRY_RECHECK_DAYS,
  type RegistryKind, type RegistryCheck, type RegistryCheckId, type RegistryOutcome, type RegistryReviewItem, type RegistryCheckInput,
} from "./verify";
