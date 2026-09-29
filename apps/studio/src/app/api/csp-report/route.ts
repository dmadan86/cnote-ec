// CSP violation reports (report-uri / report-to target, see @cnote/security CSP_REPORT_PATH). Always answers 204.
export { handleCspReport as POST } from "@cnote/security";
