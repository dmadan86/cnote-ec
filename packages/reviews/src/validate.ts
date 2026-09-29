import { redactPii } from "@cnote/ai";
import { z } from "zod";

/** Contact details in public text bypass the credit/lead model and are PII (ADR-002, ADR-010). */
const noContactInfo = (s: string) => redactPii(s) === s;
const NO_PII = "Please remove phone numbers, email addresses and ID numbers. Use the enquiry chat to share contact details.";

const text = (min: number, max: number, label: string) =>
  z.string().trim().min(min, `${label} must be at least ${min} characters.`).max(max, `${label} must be at most ${max} characters.`).refine(noContactInfo, NO_PII);

export const reviewInput = z.object({
  rating: z.number("Choose a star rating.").int("Choose a star rating.").min(1, "Choose a star rating.").max(5, "Choose a star rating."),
  title: z
    .string()
    .trim()
    .max(120, "Title must be at most 120 characters.")
    .refine(noContactInfo, NO_PII)
    .optional()
    .transform((v) => (v ? v : null)),
  body: text(10, 2000, "Your review"),
  language: z.string().min(2).max(8).default("en"),
});
export type ReviewInput = z.input<typeof reviewInput>;

export const commentInput = z.object({
  body: text(2, 1000, "Your comment"),
  parentId: z.uuid().optional(),
  language: z.string().min(2).max(8).default("en"),
});
export type CommentInput = z.input<typeof commentInput>;

export const replyInput = z.object({ body: text(2, 1000, "Your reply") });

export const reportReason = z.string().trim().min(3, "Tell us briefly what is wrong.").max(300, "Keep the reason under 300 characters.");
