import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { redactFormat } from '../redact.js';

export interface DebugLoggerOptions {
  serviceName?: string;
  logDir?: string;
  enableFile?: boolean;
}

export function createDebugLogger(options: DebugLoggerOptions = {}): winston.Logger {
  const serviceName = options.serviceName ?? 'debugger';
  const enableFile = options.enableFile ?? true;
  const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');

  const transports: winston.transport[] = [
    new winston.transports.Console({
      level: 'debug',
      format: winston.format.combine(
        winston.format.timestamp(),
        redactFormat(),
        process.env.NODE_ENV === 'production'
          ? winston.format.json()
          : winston.format.printf((info) => {
              const { timestamp, level, message, ...meta } = info;
              const metaKeys = Object.keys(meta).filter(
                (k) => !['service', 'type'].includes(k),
              );
              const metaPart = metaKeys.length > 0 ? ` ${JSON.stringify(meta)}` : '';
              return `${timestamp} [${level.toUpperCase()}] [${serviceName}]: ${message}${metaPart}`;
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
          filename: path.join(logDir, 'debug.log'),
          level: 'debug',
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
    level: 'debug',
    defaultMeta: { service: serviceName, type: 'debug' },
    transports,
  });
}

export const debugLogger = createDebugLogger();

export function logDebug(
  message: string,
  meta?: Record<string, unknown>,
  logger: winston.Logger = debugLogger,
): void {
  logger.debug(message, meta);
}
