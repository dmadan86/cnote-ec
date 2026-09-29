import { Clarity } from "./clarity";
import { ConsentBanner } from "./consent-banner";

export { ManageConsentLink } from "./consent-banner";

/** Mount once in the root layout. Renders nothing unless NEXT_PUBLIC_CLARITY_PROJECT_ID is set. */
export function Analytics() {
  const projectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  if (!projectId) return null;
  return (
    <>
      <Clarity projectId={projectId} />
      <ConsentBanner />
    </>
  );
}
