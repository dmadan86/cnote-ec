"use server";
import { z } from "zod";
import { cancelJob, confirmImportJob, createExportJob, type BulkJobView } from "@cnote/bulk";
import { actorOf, type ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";

const uuid = z.string().uuid();

export async function confirmImportAction(jobId: string, skipInvalid: boolean): Promise<ActionResult<BulkJobView>> {
  const session = await requireSeller("/listings/import");
  return run(() => confirmImportJob(actorOf(session), uuid.parse(jobId), { skipInvalid }));
}

export async function cancelJobAction(jobId: string): Promise<ActionResult<BulkJobView>> {
  const session = await requireSeller("/listings/import");
  return run(() => cancelJob(actorOf(session), uuid.parse(jobId)));
}

export async function createExportAction(input: { format: "xlsx" | "csv"; includeImages: boolean }): Promise<ActionResult<BulkJobView>> {
  const session = await requireSeller("/listings/export");
  return run(() => createExportJob(actorOf(session), { format: z.enum(["xlsx", "csv"]).parse(input.format), includeImages: !!input.includeImages }));
}
