// ============================================================
// Circuit Breaker — State Machine
//
// CLOSED    → normal operation, count failures
// OPEN      → reject all requests immediately
// HALF_OPEN → allow 1 probe request to test recovery
//
// Transitions:
//   CLOSED -(failures>=threshold)→ OPEN
//   OPEN  -(timeout elapsed)→ HALF_OPEN
//   HALF_OPEN -(probe succeeds)→ CLOSED
//   HALF_OPEN -(probe fails)→ OPEN
// ============================================================

import { CircuitBreakerOpenError } from "./errors.js";

export enum CircuitState {
  CLOSED = "CLOSED",
  OPEN = "OPEN",
  HALF_OPEN = "HALF_OPEN",
}

export interface CircuitEvent {
  type: "OPEN" | "HALF_OPEN" | "CLOSE" | "FAILURE" | "SUCCESS" | "REJECTED";
  timestamp: Date;
  consecutiveFailures: number;
  error?: Error;
}

export interface CircuitBreakerConfig {
  failureThreshold: number; // consecutive failures to trip (default: 3)
  successThreshold: number; // successes in HALF_OPEN to close (default: 1)
  openTimeoutMs: number; // time in OPEN before transitioning to HALF_OPEN (default: 30000)
  monitor?: (event: CircuitEvent) => void;
}

const DEFAULT_CB_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 3,
  successThreshold: 1,
  openTimeoutMs: 30000,
};

export class CircuitBreaker {
  private _state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures: number = 0;
  private consecutiveSuccesses: number = 0;
  private openedAt: Date | null = null;
  private halfOpenAt: Date | null = null;
  private lastFailureAt: Date | null = null;
  private lastSuccessAt: Date | null = null;
  private openTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly config: Required<CircuitBreakerConfig>;
  private pendingProbes: number = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    this.config = { ...DEFAULT_CB_CONFIG, ...config } as Required<CircuitBreakerConfig>;
  }

  /**
   * Call a function through the circuit breaker.
   * Throws CircuitBreakerOpenError if the breaker is OPEN.
   */
  async call<T>(fn: () => Promise<T>): Promise<T> {
    if (this._state === CircuitState.OPEN) {
      const remainingMs = this.remainingOpenMs();
      if (remainingMs > 0) {
        this.emit({
          type: "REJECTED",
          timestamp: new Date(),
          consecutiveFailures: this.consecutiveFailures,
        });
        throw new CircuitBreakerOpenError(
          this.openedAt!,
          remainingMs
        );
      }

      // Timeout elapsed — transition to HALF_OPEN
      this.transitionTo(CircuitState.HALF_OPEN);
    }

    if (this._state === CircuitState.HALF_OPEN && this.pendingProbes >= 1) {
      // Only 1 probe allowed at a time in HALF_OPEN
      this.emit({
        type: "REJECTED",
        timestamp: new Date(),
        consecutiveFailures: this.consecutiveFailures,
      });
      throw new CircuitBreakerOpenError(
        this.openedAt!,
        0
      );
    }

    try {
      this.pendingProbes++;
      const result = await fn();
      this.onSuccess();
      return result;
    } catch (error) {
      this.onFailure(error instanceof Error ? error : new Error(String(error)));
      throw error;
    } finally {
      this.pendingProbes--;
    }
  }

  get state(): CircuitState {
    return this._state;
  }

  get metrics() {
    return {
      state: this._state,
      consecutiveFailures: this.consecutiveFailures,
      openedAt: this.openedAt,
      halfOpenAt: this.halfOpenAt,
      lastFailureAt: this.lastFailureAt,
      lastSuccessAt: this.lastSuccessAt,
      remainingOpenMs: this._state === CircuitState.OPEN ? this.remainingOpenMs() : 0,
    };
  }

  forceState(state: CircuitState): void {
    this.transitionTo(state);
    if (state === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
    }
  }

  reset(): void {
    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }
    this._state = CircuitState.CLOSED;
    this.consecutiveFailures = 0;
    this.consecutiveSuccesses = 0;
    this.openedAt = null;
    this.halfOpenAt = null;
    this.lastFailureAt = null;
    this.lastSuccessAt = null;
    this.pendingProbes = 0;
  }

  // ---- private ----

  private onSuccess(): void {
    this.lastSuccessAt = new Date();
    this.emit({
      type: "SUCCESS",
      timestamp: new Date(),
      consecutiveFailures: this.consecutiveFailures,
    });

    if (this._state === CircuitState.HALF_OPEN) {
      this.consecutiveSuccesses++;
      if (this.consecutiveSuccesses >= this.config.successThreshold) {
        this.transitionTo(CircuitState.CLOSED);
      }
    }

    if (this._state === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
    }
  }

  private onFailure(error: Error): void {
    this.consecutiveFailures++;
    this.lastFailureAt = new Date();
    this.emit({
      type: "FAILURE",
      timestamp: new Date(),
      consecutiveFailures: this.consecutiveFailures,
      error,
    });
    this.consecutiveSuccesses = 0;

    if (this._state === CircuitState.HALF_OPEN) {
      this.transitionTo(CircuitState.OPEN);
      return;
    }

    if (
      this._state === CircuitState.CLOSED &&
      this.consecutiveFailures >= this.config.failureThreshold
    ) {
      this.transitionTo(CircuitState.OPEN);
    }
  }

  private transitionTo(newState: CircuitState): void {
    const oldState = this._state;
    this._state = newState;

    if (this.openTimer) {
      clearTimeout(this.openTimer);
      this.openTimer = null;
    }

    if (newState === CircuitState.OPEN) {
      this.openedAt = new Date();
      this.emit({
        type: "OPEN",
        timestamp: new Date(),
        consecutiveFailures: this.consecutiveFailures,
      });

      // Auto-transition to HALF_OPEN after timeout
      this.openTimer = setTimeout(() => {
        if (this._state === CircuitState.OPEN) {
          this.transitionTo(CircuitState.HALF_OPEN);
        }
      }, this.config.openTimeoutMs);
    }

    if (newState === CircuitState.HALF_OPEN) {
      this.halfOpenAt = new Date();
      this.consecutiveSuccesses = 0;
      this.emit({
        type: "HALF_OPEN",
        timestamp: new Date(),
        consecutiveFailures: this.consecutiveFailures,
      });
    }

    if (newState === CircuitState.CLOSED) {
      this.consecutiveFailures = 0;
      this.consecutiveSuccesses = 0;
      this.openedAt = null;
      this.halfOpenAt = null;
      this.emit({
        type: "CLOSE",
        timestamp: new Date(),
        consecutiveFailures: 0,
      });
    }
  }

  private remainingOpenMs(): number {
    if (!this.openedAt) return 0;
    const elapsed = Date.now() - this.openedAt.getTime();
    return Math.max(0, this.config.openTimeoutMs - elapsed);
  }

  private emit(event: CircuitEvent): void {
    this.config.monitor?.(event);
  }
}
