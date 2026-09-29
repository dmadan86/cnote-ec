import { domainsConfig } from "../config";
import { AwsEdgeProvider } from "./aws";
import { CloudflareEdgeProvider } from "./cloudflare";
import { MockEdgeProvider } from "./mock";
import type { EdgeProvider } from "./types";
import { VercelEdgeProvider } from "./vercel";

export * from "./types";
export { MockEdgeProvider, CloudflareEdgeProvider, VercelEdgeProvider, AwsEdgeProvider };

export function createEdgeProvider(name: string = domainsConfig().provider): EdgeProvider {
  switch (name) {
    case "cloudflare":
      return new CloudflareEdgeProvider();
    case "vercel":
      return new VercelEdgeProvider();
    case "aws":
      return new AwsEdgeProvider();
    default:
      return new MockEdgeProvider();
  }
}

let instance: EdgeProvider | undefined;
/** Process-wide provider selected by EDGE_PROVIDER (default mock). */
export function getEdgeProvider(): EdgeProvider {
  return (instance ??= createEdgeProvider());
}
export function setEdgeProvider(p: EdgeProvider | undefined) {
  instance = p;
}
