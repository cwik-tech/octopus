/**
 * Runtime Foundation — In-Memory Circuit Breaker
 *
 * Simple per-provider circuit breaker to fast-fail when a provider has
 * consecutive failures, reducing wasted retries and provider load.
 *
 * States:
 *   CLOSED  → normal operation, counting failures
 *   OPEN    → fast-failing all requests for a cooldown window
 *   HALF_OPEN → after cooldown, next request tests recovery
 */

import { logRuntimeEvent } from './logger.js'

export type CircuitState = 'closed' | 'open' | 'half_open'

export interface CircuitBreakerOptions {
  /** Number of consecutive failures before opening the circuit. */
  failureThreshold?: number
  /** Cooldown duration in ms while the circuit stays OPEN. */
  cooldownMs?: number
  /** Half-open test window in ms (default same as cooldown). */
  halfOpenMs?: number
}

interface CircuitRecord {
  state: CircuitState
  failures: number
  lastFailureAt: number
  openedAt: number
  halfOpenedAt: number
  halfOpenTestInFlight: boolean
}

const DEFAULT_FAILURE_THRESHOLD = 5
const DEFAULT_COOLDOWN_MS = 30000

export class CircuitBreakerRegistry {
  private readonly records = new Map<string, CircuitRecord>()
  private readonly options: Required<CircuitBreakerOptions>

  constructor(options: CircuitBreakerOptions = {}) {
    this.options = {
      failureThreshold: options.failureThreshold ?? DEFAULT_FAILURE_THRESHOLD,
      cooldownMs: options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
      halfOpenMs: options.halfOpenMs ?? options.cooldownMs ?? DEFAULT_COOLDOWN_MS,
    }
  }

  /**
   * Check whether a provider request should be allowed.
   * Returns `{ allowed: true }` or `{ allowed: false, reason: string }`.
   */
  check(provider: string): { allowed: boolean; reason?: string } {
    const record = this.getRecord(provider)

    if (record.state === 'open') {
      if (Date.now() - record.openedAt >= this.options.cooldownMs) {
        record.state = 'half_open'
        record.halfOpenedAt = Date.now()
        record.halfOpenTestInFlight = true
        return { allowed: true }
      }
      return {
        allowed: false,
        reason: `Circuit breaker OPEN for provider '${provider}' (cooldown: ${this.options.cooldownMs}ms)`,
      }
    }

    if (record.state === 'half_open') {
      if (Date.now() - record.halfOpenedAt >= this.options.halfOpenMs) {
        // Half-open window expired without a test — go back to open
        record.state = 'open'
        record.openedAt = Date.now()
        record.halfOpenTestInFlight = false
        return {
          allowed: false,
          reason: `Circuit breaker OPEN for provider '${provider}' (half-open test timed out)`,
        }
      }
      // Allow exactly one test request through half-open
      if (record.halfOpenTestInFlight) {
        return {
          allowed: false,
          reason: `Circuit breaker HALF_OPEN for provider '${provider}' (test request in flight)`,
        }
      }
      record.halfOpenTestInFlight = true
      return { allowed: true }
    }

    return { allowed: true }
  }

  /** Record a success — resets failure count and closes the circuit. */
  recordSuccess(provider: string, workspacePath?: string): void {
    const record = this.getRecord(provider)
    const previousState = record.state
    record.failures = 0
    record.state = 'closed'
    record.halfOpenTestInFlight = false
    if (previousState !== 'closed') {
      this.logEvent(provider, 'circuit.close', workspacePath)
    }
  }

  /** Record a failure — increments count and may open the circuit. */
  recordFailure(provider: string, workspacePath?: string): void {
    const record = this.getRecord(provider)
    record.failures++
    record.lastFailureAt = Date.now()

    if (record.state === 'half_open') {
      // Test request failed — re-open immediately
      record.state = 'open'
      record.openedAt = Date.now()
      record.halfOpenTestInFlight = false
      this.logEvent(provider, 'circuit.open', workspacePath, 'half_open_test_failed')
      return
    }

    if (record.state === 'closed' && record.failures >= this.options.failureThreshold) {
      record.state = 'open'
      record.openedAt = Date.now()
      record.halfOpenTestInFlight = false
      this.logEvent(provider, 'circuit.open', workspacePath, `failure_count=${record.failures}`)
    }
  }

  /** Get the current state of a provider's circuit. */
  getState(provider: string): CircuitState {
    return this.getRecord(provider).state
  }

  /** Reset all circuits (useful for tests or admin commands). */
  resetAll(): void {
    this.records.clear()
  }

  private getRecord(provider: string): CircuitRecord {
    const existing = this.records.get(provider)
    if (existing) return existing
    const record: CircuitRecord = {
      state: 'closed',
      failures: 0,
      lastFailureAt: 0,
      openedAt: 0,
      halfOpenedAt: 0,
      halfOpenTestInFlight: false,
    }
    this.records.set(provider, record)
    return record
  }

  private logEvent(
    provider: string,
    event: string,
    workspacePath?: string,
    detail?: string,
  ): void {
    if (workspacePath) {
      logRuntimeEvent(workspacePath, {
        timestamp: new Date().toISOString(),
        event,
        provider,
        detail: detail ?? `state=${this.getState(provider)}`,
      })
    }
  }
}

/** Singleton registry used across the runtime. */
export const globalCircuitBreaker = new CircuitBreakerRegistry()
