import { router } from "../helpers";
import { buyerRoutes } from "./buyer";
import { bulkRoutes } from "./bulk";
import { catalogueRoutes } from "./catalogue";
import { engagementRoutes } from "./engagement";
import { sellerRoutes } from "./seller";

export const v1 = router();
v1.route("/", catalogueRoutes);
v1.route("/", sellerRoutes);
v1.route("/", bulkRoutes);
v1.route("/", buyerRoutes);
v1.route("/", engagementRoutes);
