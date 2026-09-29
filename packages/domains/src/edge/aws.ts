import type { EdgeProvider, EdgeStatus } from "./types";

/**
 * AWS adapter (documented stub, not implemented). Intended design:
 *  - CloudFront multi-tenant distribution (SaaS Manager "distribution tenants") or one distribution with an
 *    alternate-domain-name list for small scale, origin = the web app load balancer, Host header forwarded.
 *  - createCustomHostname: ACM RequestCertificate (DNS validation, us-east-1) then, once ISSUED, create the tenant /
 *    add the CNAME alias. Return the validation CNAME as `records` (purpose "ownership") so sellers can add it.
 *  - getStatus: ACM DescribeCertificate (PENDING_VALIDATION -> pending, ISSUED + tenant Deployed -> active, FAILED -> failed).
 *  - delete: remove the alias/tenant, then DeleteCertificate.
 * Azure Front Door custom domains map the same way (AFD custom domain + managed cert).
 * Implement with the AWS SDK behind this interface; nothing else in the app changes.
 */
export class AwsEdgeProvider implements EdgeProvider {
  readonly name = "aws";
  readonly caaIssuers = ["amazon.com", "amazontrust.com", "awstrust.com", "amazonaws.com"];
  private nope(): never {
    throw new Error("EDGE_PROVIDER=aws is not implemented yet. See packages/domains/src/edge/aws.ts and docs/design/custom-domains.md.");
  }
  async createCustomHostname(_hostname: string): Promise<{ ref: string; status: EdgeStatus }> {
    return this.nope();
  }
  async getStatus(_ref: string): Promise<EdgeStatus> {
    return this.nope();
  }
  async delete(_ref: string): Promise<void> {
    return this.nope();
  }
}
