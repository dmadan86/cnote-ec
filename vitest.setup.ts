// Loads local env for package tests (CI provides env directly). DB/Redis-backed tests run against
// the local dev database: use unique emails/ids per test and clean up what you create.
import { config } from "dotenv";
import path from "node:path";

config({ path: path.resolve(import.meta.dirname, ".env.local"), quiet: true });
