import fs from 'node:fs';
import path from 'node:path';
import winston from 'winston';
import { redactFormat } from './redact.js';

export interface LoggerOptions {
  level?: string;
  logDir?: string;
  enableFile?: boolean;
  json?: boolean;
}

const normalizeMsgFormat = winston.format((info) => {
  if (info.message && !info.msg) {
    info.msg = info.message;
  } else if (info.msg && !info.message) {
    info.message = info.msg;
  }
  return info;
});

export function createLogger(serviceName: string, options: LoggerOptions = {}): winston.Logger {
  const level = options.level || process.env.LOG_LEVEL || 'info';
  const enableFile = options.enableFile ?? false;
  const logDir = options.logDir ?? path.resolve(process.cwd(), 'logs');
  const isJson = options.json ?? (process.env.NODE_ENV === 'production');

  const transports: winston.transport[] = [
    new winston.transports.Console({
      format: winston.format.combine(
        winston.format.timestamp(),
        winston.format.errors({ stack: true }),
        redactFormat(),
        normalizeMsgFormat(),
        isJson
          ? winston.format.json()
          : winston.format.printf((info) => {
              const { timestamp, level: lvl, message, service, requestId, userId, engineSeq, stack } = info;
              const reqPart = requestId ? ` [req:${requestId}]` : '';
              const userPart = userId ? ` [user:${userId}]` : '';
              const seqPart = engineSeq !== undefined ? ` [seq:${engineSeq}]` : '';
              const stackPart = stack ? `\n${stack}` : '';
              return `${timestamp} [${lvl.toUpperCase()}] [${service || serviceName}]${reqPart}${userPart}${seqPart}: ${message}${stackPart}`;
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
          filename: path.join(logDir, `${serviceName}.log`),
          format: winston.format.combine(
            winston.format.timestamp(),
            winston.format.errors({ stack: true }),
            redactFormat(),
            normalizeMsgFormat(),
            winston.format.json(),
          ),
        }),
      );
    } catch {
      // Graceful fallback if filesystem access fails in restricted sandboxes
    }
  }

  return winston.createLogger({
    level,
    defaultMeta: { service: serviceName },
    transports,
  });
}
