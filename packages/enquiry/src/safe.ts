import { cascade } from "./matching";

/** Cascade after the triggering commit; a failure is logged, the 1-minute sweep job retries. */
export async function cascadeSafe(enquiryId: string): Promise<void> {
  try {
    await cascade(enquiryId);
  } catch (err) {
    console.error("[enquiry] cascade failed", enquiryId, err);
  }
}
