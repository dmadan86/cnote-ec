import { router } from "../helpers";
import { agentRoutes } from "./agents";
import { buyerRoutes } from "./buyer";
import { bulkRoutes } from "./bulk";
import { catalogueRoutes } from "./catalogue";
import { contractRoutes } from "./contracts";
import { engagementRoutes } from "./engagement";
import { sampleRoutes } from "./samples";
import { sellerRoutes } from "./seller";

export const v1 = router();
v1.route("/", catalogueRoutes);
v1.route("/", sellerRoutes);
v1.route("/", bulkRoutes);
v1.route("/", buyerRoutes);
v1.route("/", engagementRoutes);
v1.route("/", agentRoutes);
v1.route("/", sampleRoutes);
v1.route("/", contractRoutes);
