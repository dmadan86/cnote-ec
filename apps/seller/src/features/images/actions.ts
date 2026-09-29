"use server";
import { z } from "zod";
import type { ListingImageView } from "@cnote/catalogue";
import type { ActionResult } from "@cnote/next-kit";
import { requireSeller } from "@/lib/auth";
import { run } from "@/lib/run";
import { catalogue } from "@/lib/services";

const uuid = z.string().uuid();

export async function deleteImageAction(imageId: string): Promise<ActionResult<null>> {
  const session = await requireSeller("/listings");
  return run(async () => {
    await catalogue.deleteListingImage(session.business.id, uuid.parse(imageId));
    return null;
  });
}

export async function reorderImagesAction(listingId: string, orderedIds: string[]): Promise<ActionResult<ListingImageView[]>> {
  const session = await requireSeller("/listings");
  return run(() => catalogue.reorderListingImages(session.business.id, uuid.parse(listingId), z.array(uuid).max(catalogue.MAX_IMAGES_PER_LISTING).parse(orderedIds)));
}

/** Editing alt text sends the image back to staff review (it is public text). */
export async function setAltTextAction(imageId: string, altText: string): Promise<ActionResult<ListingImageView>> {
  const session = await requireSeller("/listings");
  return run(() => catalogue.setImageAltText(session.business.id, uuid.parse(imageId), z.string().max(200).parse(altText)));
}
