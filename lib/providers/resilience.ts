/**
 * providers/resilience.ts — Retry and circuit breaker policies for provider calls.
 *
 * Uses cockatiel for lightweight resilience without heavyweight orchestration.
 * Applied to GitHub/GitLab CLI calls that can fail due to network, rate limits, or timeouts.
 */
import {
  ExponentialBackoff,
  retry,
  circuitBreaker,
  ConsecutiveBreaker,
  handleAll,
  wrap,
  type IPolicy,
} from "cockatiel";

/**
 * Default retry policy: 3 attempts with exponential backoff.
 * Handles all errors (network, timeout, CLI failure).
 */
const retryPolicy = retry(handleAll, {
  maxAttempts: 3,
  backoff: new ExponentialBackoff({
    initialDelay: 500,
    maxDelay: 5_000,
  }),
});

/**
 * Circuit breaker: opens after 5 consecutive failures, half-opens after 30s.
 * Prevents hammering a provider that's down.
 */
const breakerPolicy = circuitBreaker(handleAll, {
  halfOpenAfter: 30_000,
  breaker: new ConsecutiveBreaker(5),
});

/**
 * Combined policy: circuit breaker wrapping retry.
 * If circuit is open, calls fail fast without retrying.
 */
export const providerPolicy: IPolicy = wrap(breakerPolicy, retryPolicy);

/**
 * Execute a provider call with retry + circuit breaker.
 */
export function withResilience<T>(fn: () => Promise<T>): Promise<T> {
  return providerPolicy.execute(() => fn());
}
