import { ThrottleBackoffConfig } from './types';

const RETRY_MODES = ['standard', 'adaptive', 'legacy'] as const;
export type RetryMode = (typeof RETRY_MODES)[number];

export interface RetryOptions {
  retryMode?: RetryMode;
  maxAttempts?: number;
}

export interface ResolvedThrottleBackoff {
  maxRetries: number;
  baseDelayMs: number;
  maxDelayMs: number;
  multiplier: number;
  jitterRatio: number;
}

export const coerceRetryMode = (value?: string | null): RetryMode | undefined => {
  if (!value) {
    return undefined;
  }

  return (RETRY_MODES as readonly string[]).includes(value)
    ? (value as RetryMode)
    : undefined;
};

export const coerceMaxAttempts = (value?: number | string | null): number | undefined => {
  if (value === undefined || value === null) {
    return undefined;
  }

  const numeric = typeof value === 'number' ? value : Number.parseInt(value, 10);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
};

export const resolveRetrySettings = (
  options?: RetryOptions
): { retryMode: RetryMode; maxAttempts?: number } => {
  const retryMode =
    options?.retryMode ??
    coerceRetryMode(process.env.AWS_RETRY_MODE) ??
    'adaptive';

  const maxAttempts =
    coerceMaxAttempts(options?.maxAttempts) ??
    coerceMaxAttempts(process.env.AWS_MAX_ATTEMPTS);

  return { retryMode, maxAttempts };
};

const DEFAULT_THROTTLE_BACKOFF: ResolvedThrottleBackoff = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  multiplier: 2,
  jitterRatio: 0.25,
};

export const resolveThrottleBackoff = (
  config?: ThrottleBackoffConfig
): ResolvedThrottleBackoff => ({
  maxRetries: Math.max(
    0,
    config?.maxRetries ?? DEFAULT_THROTTLE_BACKOFF.maxRetries
  ),
  baseDelayMs:
    config?.baseDelayMs ?? DEFAULT_THROTTLE_BACKOFF.baseDelayMs,
  maxDelayMs:
    config?.maxDelayMs ?? DEFAULT_THROTTLE_BACKOFF.maxDelayMs,
  multiplier:
    config?.multiplier ?? DEFAULT_THROTTLE_BACKOFF.multiplier,
  jitterRatio: Math.max(
    0,
    config?.jitterRatio ?? DEFAULT_THROTTLE_BACKOFF.jitterRatio
  ),
});

export const isThrottlingError = (error: any): boolean => {
  if (!error) return false;
  const name =
    error.name ||
    error.code ||
    error.Code ||
    error.__type ||
    error['$fault'] ||
    '';

  if (
    typeof name === 'string' &&
    ['ThrottlingException', 'ThrottledException', 'TooManyRequestsException'].some(
      (n) => name.includes(n)
    )
  ) {
    return true;
  }

  const statusCode = error.$metadata?.httpStatusCode;
  return statusCode === 429;
};

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export const calculateBackoffDelay = (
  attempt: number,
  config: ResolvedThrottleBackoff
): number => {
  const expDelay = config.baseDelayMs * Math.pow(config.multiplier, attempt - 1);
  const cappedDelay = Math.min(expDelay, config.maxDelayMs);
  const jitterRange = cappedDelay * config.jitterRatio;
  const jitter =
    jitterRange === 0
      ? 0
      : (Math.random() * jitterRange * 2 - jitterRange);
  const delay = Math.max(0, cappedDelay + jitter);
  return Math.floor(delay);
};

export interface RetryOnThrottleOptions {
  backoff: ResolvedThrottleBackoff;
  onRetry?: (details: { attempt: number; delayMs: number; error: any }) => void;
}

export const retryOnThrottle = async <T>(
  fn: (attempt: number) => Promise<T>,
  options: RetryOnThrottleOptions
): Promise<T> => {
  const maxAttempts = options.backoff.maxRetries + 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (error) {
      const isThrottle = isThrottlingError(error);
      const isLastAttempt = attempt === maxAttempts;

      if (!isThrottle || isLastAttempt) {
        throw error;
      }

      const delayMs = calculateBackoffDelay(attempt, options.backoff);
      options.onRetry?.({ attempt, delayMs, error });
      await sleep(delayMs);
    }
  }

  throw new Error('retryOnThrottle exhausted without returning a result');
};

