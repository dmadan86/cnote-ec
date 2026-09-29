import type { ModuleWorker } from "@cnote/core";
import { erasePersonWishlists } from "./lists";

export const worker: ModuleWorker = {
  name: "wishlist",
  handlers: {
    DataErasureRequested: async (e) => {
      await erasePersonWishlists(e.payload.personId);
    },
  },
  jobs: [],
};
