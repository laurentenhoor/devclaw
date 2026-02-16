/**
 * testing/ — Test infrastructure for DevClaw integration tests.
 *
 * Exports:
 * - TestProvider: In-memory IssueProvider with call tracking
 * - createTestHarness: Scaffolds temp workspace + mock runCommand
 */
export { TestProvider, type ProviderCall } from "./test-provider.js";
export {
  createTestHarness,
  type TestHarness,
  type HarnessOptions,
  type CommandInterceptor,
  type CapturedCommand,
  type BootstrapFile,
} from "./harness.js";
