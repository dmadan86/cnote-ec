import { ConsentManager } from "@/features/consent";
import { Clarity } from "./clarity";

/**
 * Mount once per page chrome. The consent banner + preferences dialog always render (every first-time visitor is asked,
 * whether or not analytics is configured); Clarity is added only when NEXT_PUBLIC_CLARITY_PROJECT_ID is set and only
 * ever loads after an analytics opt-in.
 */
export function Analytics() {
  const projectId = process.env.NEXT_PUBLIC_CLARITY_PROJECT_ID;
  return (
    <>
      {projectId ? <Clarity projectId={projectId} /> : null}
      <ConsentManager />
    </>
  );
}
