import winston from 'winston';

const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /token/i,
  /secret/i,
  /auth(orization)?/i,
  /cookie/i,
  /jwt/i,
  /api[_-]?key/i,
  /credit[_-]?card/i,
  /private[_-]?key/i,
];

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
}

export function redactSensitiveData(data: unknown, seen = new WeakSet<object>()): unknown {
  if (data === null || data === undefined) return data;

  if (typeof data !== 'object') {
    return data;
  }

  if (seen.has(data as object)) {
    return '[CIRCULAR]';
  }
  seen.add(data as object);

  if (Array.isArray(data)) {
    return data.map((item) => redactSensitiveData(item, seen));
  }

  if (data instanceof Error) {
    const errorCopy: Record<string, unknown> = {
      name: data.name,
      message: data.message,
      stack: data.stack,
    };
    for (const [key, value] of Object.entries(data)) {
      if (isSensitiveKey(key)) {
        errorCopy[key] = '[REDACTED]';
      } else {
        errorCopy[key] = redactSensitiveData(value, seen);
      }
    }
    return errorCopy;
  }

  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data as Record<string, unknown>)) {
    if (isSensitiveKey(key)) {
      result[key] = '[REDACTED]';
    } else {
      result[key] = redactSensitiveData(value, seen);
    }
  }

  return result;
}

export const redactFormat = winston.format((info) => {
  const redacted = redactSensitiveData(info) as winston.Logform.TransformableInfo;
  return redacted;
});
