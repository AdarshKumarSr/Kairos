import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { redactFormat } from '../redact.js';

export interface ErrorLoggerOptions {
  serviceName?: string;
  logDir?: string;
  enableFile?: boolean;
}

export interface ErrorLogContext {
  requestId?: string;
  userId?: string;
  service?: string;
  code?: string;
  statusCode?: number;
  details?: unknown;
  meta?: Record<string, unknown>;
}

export function createErrorLogger(options: ErrorLoggerOptions = {}): winston.Logger {
  const serviceName = options.serviceName ?? 'error-handler';
  const enableFile = options.enableFile ?? true;
  const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');

  const transports: winston.transport[] = [
    new winston.transports.Console({
      level: 'error',
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        redactFormat(),
        process.env.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.printf((info) => {
              const { timestamp, level, message, stack, requestId, userId, code } = info;
              const reqPart = requestId ? ` [req:${requestId}]` : '';
              const userPart = userId ? ` [user:${userId}]` : '';
              const codePart = code ? ` [code:${code}]` : '';
              const stackPart = stack ? `\n${stack}` : '';
              return `${timestamp} [${level.toUpperCase()}] [${serviceName}]${reqPart}${userPart}${codePart}: ${message}${stackPart}`;
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
          filename: path.join(logDir, 'error.log'),
          level: 'error',
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
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
    level: 'error',
    defaultMeta: { service: serviceName, type: 'error' },
    transports,
  });
}

export const errorLogger = createErrorLogger();

export function logError(
  error: unknown,
  context: ErrorLogContext = {},
  logger: winston.Logger = errorLogger,
): void {
  let message = 'An unknown error occurred';
  let stack: string | undefined;
  let name = 'Error';
  let code = context.code;
  let statusCode = context.statusCode;
  let details = context.details;

  if (error instanceof Error) {
    message = error.message;
    stack = error.stack;
    name = error.name;
    const errObj = error as unknown as Record<string, unknown>;
    if (!code && typeof errObj.code === 'string') code = errObj.code;
    if (!statusCode && typeof errObj.statusCode === 'number') statusCode = errObj.statusCode;
    if (!details && errObj.details) details = errObj.details;
  } else if (typeof error === 'string') {
    message = error;
  } else if (typeof error === 'object' && error !== null) {
    const errObj = error as unknown as Record<string, unknown>;
    if (typeof errObj.message === 'string') message = errObj.message;
    if (typeof errObj.code === 'string') code = errObj.code;
    if (typeof errObj.statusCode === 'number') statusCode = errObj.statusCode;
    if (errObj.details) details = errObj.details;
  }

  logger.error({
    message,
    name,
    stack,
    code,
    statusCode,
    details,
    requestId: context.requestId,
    userId: context.userId,
    service: context.service,
    ...(context.meta ? { meta: context.meta } : {}),
  });
}
