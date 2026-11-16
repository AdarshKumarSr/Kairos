import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { redactFormat } from '../redact.js';

export interface ApiLoggerOptions {
  serviceName?: string;
  logDir?: string;
  enableFile?: boolean;
  slowRequestThresholdMs?: number;
}

export interface ApiRequestLogParams {
  method: string;
  url: string;
  statusCode: number;
  durationMs: number;
  requestId?: string;
  userId?: string;
  ip?: string;
  userAgent?: string;
  meta?: Record<string, unknown>;
}

export const DEFAULT_SLOW_THRESHOLD_MS = 200;

export function createApiLogger(options: ApiLoggerOptions = {}): winston.Logger {
  const serviceName = options.serviceName ?? 'api-gateway';
  const enableFile = options.enableFile ?? true;
  const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        redactFormat(),
        process.env.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.printf((info) => {
              const { timestamp, level, message, method, url, statusCode, durationMs, requestId, userId } = info;
              const reqPart = requestId ? ` [req:${requestId}]` : '';
              const userPart = userId ? ` [user:${userId}]` : '';
              const statPart = statusCode ? ` -> ${statusCode}` : '';
              const durPart = durationMs !== undefined ? ` (${durationMs}ms)` : '';
              const httpPart = method && url ? ` ${method} ${url}` : '';
              return `${timestamp} [${level.toUpperCase()}] [${serviceName}]${reqPart}${userPart}:${httpPart}${statPart}${durPart} ${message}`;
            }),
      ),
    }),
  ];

  if (enableFile) {
    try {
      if (!fs.existsSync(logDir)) {
        fs.mkdirSync(logDir, { recursive: true });
      }
      transports.push(
        new winston.transports.File({
          filename: path.join(logDir, 'api.log'),
          format: winston.format.combine(
            winston.format.timestamp(),
            redactFormat(),
            winston.format.json(),
          ),
        }),
      );
    } catch {
      // In constrained environments where directory creation might fail, fallback gracefully to console
    }
  }

  return winston.createLogger({
    level: process.env.LOG_LEVEL || 'info',
    defaultMeta: { service: serviceName, type: 'api' },
    transports,
  });
}

export const apiLogger = createApiLogger();

export function logApiRequest(
  params: ApiRequestLogParams,
  logger: winston.Logger = apiLogger,
  slowThresholdMs: number = DEFAULT_SLOW_THRESHOLD_MS,
): void {
  const isSlow = params.durationMs > slowThresholdMs;
  const level = isSlow ? 'warn' : 'info';
  const slowPrefix = isSlow ? `[SLOW REQUEST > ${slowThresholdMs}ms] ` : '';
  const message = `${slowPrefix}${params.method} ${params.url} ${params.statusCode} (${params.durationMs}ms)`;

  logger.log({
    level,
    message,
    method: params.method,
    url: params.url,
    statusCode: params.statusCode,
    durationMs: params.durationMs,
    requestId: params.requestId,
    userId: params.userId,
    ip: params.ip,
    userAgent: params.userAgent,
    isSlow,
    ...(params.meta ? { meta: params.meta } : {}),
  });
}
