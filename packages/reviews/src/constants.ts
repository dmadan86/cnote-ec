/** Fixed author id for anonymised comments (DPDP erasure). Reviews use tombstoneForReview() instead. */
export const TOMBSTONE_PERSON_ID = "00000000-0000-4000-8000-000000000000";
const TOMBSTONE_PREFIX = "00000000-0000-4000-8000-";

export const REPORT_THRESHOLD = 3;
export const REVIEWS_PER_DAY = 5;
export const COMMENTS_PER_HOUR = 20;
export const REACTIONS_PER_HOUR = 60;
export const PAGE_SIZE = 10;

export const isTombstone = (personId: string) => personId.startsWith(TOMBSTONE_PREFIX);
