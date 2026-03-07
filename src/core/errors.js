/**
 * Error handling with Circuit Breaker pattern
 * Prevents cascading failures with exponential backoff
 */

class CircuitBreaker {
  constructor(options = {}) {
    this.failureThreshold = options.failureThreshold || 5;
    this.resetTimeout = options.resetTimeout || 60000; // 1 min
    this.backoffMultiplier = options.backoffMultiplier || 2;
    this.maxBackoff = options.maxBackoff || 300000; // 5 min

    this.failureCount = 0;
    this.state = 'CLOSED'; // CLOSED, OPEN, HALF_OPEN
    this.nextAttemptTime = Date.now();
    this.backoffTime = this.resetTimeout;
  }

  async execute(fn) {
    if (this.state === 'OPEN') {
      if (Date.now() < this.nextAttemptTime) {
        throw new Error(`Circuit breaker OPEN. Retry after ${Math.ceil((this.nextAttemptTime - Date.now()) / 1000)}s`);
      }
      this.state = 'HALF_OPEN';
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure();
      throw err;
    }
  }

  _onSuccess() {
    this.failureCount = 0;
    this.state = 'CLOSED';
    this.backoffTime = this.resetTimeout;
  }

  _onFailure() {
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold) {
      this.state = 'OPEN';
      this.nextAttemptTime = Date.now() + this.backoffTime;
      this.backoffTime = Math.min(this.backoffTime * this.backoffMultiplier, this.maxBackoff);
    }
  }

  getState() {
    return { state: this.state, failures: this.failureCount };
  }
}

// Exponential backoff retry helper
async function retryWithBackoff(fn, options = {}) {
  const { maxRetries = 3, initialDelay = 1000, maxDelay = 30000, multiplier = 2 } = options;

  let lastErr;
  let delay = initialDelay;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (i < maxRetries - 1) {
        await new Promise(resolve => setTimeout(resolve, delay));
        delay = Math.min(delay * multiplier, maxDelay);
      }
    }
  }

  throw lastErr;
}

module.exports = { CircuitBreaker, retryWithBackoff };
