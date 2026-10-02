import { redactPii } from "@cnote/ai";
import { z } from "zod";
import { ANSWER_MAX, ANSWER_MIN, QA_SEARCH_MAX, QUESTION_MAX, QUESTION_MIN } from "./constants";

export const REMOVED = "[removed]";

/** Messaging deep links and long digit runs (spaced/dotted phone numbers the PHONE pattern misses). */
const MESSENGER_LINK = /\b(?:https?:\/\/)?(?:wa\.me|api\.whatsapp\.com|chat\.whatsapp\.com|t\.me|telegram\.me)\/\S*/gi;
const DIGIT_RUN = /\d(?:[\s.\-()]{0,3}\d){9,}/g;

/**
 * Removes phone numbers, emails, ID numbers (Aadhaar/PAN/GSTIN) and messenger links from public text so a Q&A
 * thread can't be used to take the conversation (and the lead) off-platform (ADR-002) or leak PII (ADR-010).
 * Stripping, not rejecting: the question still goes through, the asker is told what was removed.
 */
export function stripContact(input: string): { text: string; stripped: boolean } {
  const redacted = redactPii(input)
    .replace(/\[(?:email|phone|aadhaar|pan|gstin)\]/g, REMOVED)
    .replace(MESSENGER_LINK, REMOVED)
    .replace(DIGIT_RUN, REMOVED);
  const text = redacted.replace(/(?:\[removed\][\s,;:/-]{0,5}){2,}/g, `${REMOVED} `).replace(/[ \t]{2,}/g, " ").trim();
  return { text, stripped: text !== input.trim() };
}

/** Characters left once removal markers are taken out (so "call 98765 43210" is not a question). */
export const meaningfulLength = (s: string) => s.replaceAll(REMOVED, "").replace(/\s+/g, " ").trim().length;

const lang = z.string().min(2).max(8).default("en");

export const questionInput = z.object({
  body: z.string().trim().min(QUESTION_MIN, `Your question must be at least ${QUESTION_MIN} characters.`).max(QUESTION_MAX, `Your question must be at most ${QUESTION_MAX} characters.`),
  language: lang,
});
export type QuestionInput = z.input<typeof questionInput>;

export const answerInput = z.object({
  body: z.string().trim().min(ANSWER_MIN, `Your answer must be at least ${ANSWER_MIN} characters.`).max(ANSWER_MAX, `Your answer must be at most ${ANSWER_MAX} characters.`),
  language: lang,
});
export type AnswerInput = z.input<typeof answerInput>;

/** Search-within-questions text: trimmed, bounded, no wildcard characters that would turn it into a scan. */
export const searchText = (q: string | null | undefined): string => (q ?? "").replace(/[%_\\]/g, " ").replace(/\s+/g, " ").trim().slice(0, QA_SEARCH_MAX);
