

-- DropIndex
DROP INDEX "storefront_domains_hostname_key";

-- CreateIndex
CREATE INDEX "storefront_domains_hostname_idx" ON "storefront_domains"("hostname");

-- CreateIndex
CREATE UNIQUE INDEX "storefront_domains_storefront_id_hostname_key" ON "storefront_domains"("storefront_id", "hostname");

