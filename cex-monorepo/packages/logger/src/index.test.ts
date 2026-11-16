import { describe, expect, it, vi } from 'vitest';
import {
  createLogger,
  isSensitiveKey,
  redactSensitiveData,
  createApiLogger,
  logApiRequest,
  DEFAULT_SLOW_THRESHOLD_MS,
  createErrorLogger,
  logError,
  createDebugLogger,
  logDebug,
  formatStartupBanner,
  printStartupBanner,
} from './index.js';

describe('@cex/logger', () => {
  describe('createLogger', () => {
    it('creates a Winston logger instance with expected methods', () => {
      const logger = createLogger('test-service');
      expect(logger).toBeDefined();
      expect(typeof logger.info).toBe('function');
      expect(typeof logger.error).toBe('function');
      expect(typeof logger.warn).toBe('function');
      expect(typeof logger.debug).toBe('function');
      expect(logger.defaultMeta).toEqual({ service: 'test-service' });
    });

    it('emits log events without throwing', () => {
      const logger = createLogger('test-service');
      expect(() => {
        logger.info('Test info message', { requestId: 'req-123', userId: 'user-456' });
      }).not.toThrow();
    });
  });

  describe('Sensitive data redaction', () => {
    it('detects sensitive keys correctly', () => {
      expect(isSensitiveKey('password')).toBe(true);
      expect(isSensitiveKey('passwordHash')).toBe(true);
      expect(isSensitiveKey('refreshToken')).toBe(true);
      expect(isSensitiveKey('accessToken')).toBe(true);
      expect(isSensitiveKey('secret')).toBe(true);
      expect(isSensitiveKey('authorization')).toBe(true);
      expect(isSensitiveKey('cookie')).toBe(true);
      expect(isSensitiveKey('jwt')).toBe(true);
      expect(isSensitiveKey('apiKey')).toBe(true);

      expect(isSensitiveKey('email')).toBe(false);
      expect(isSensitiveKey('username')).toBe(false);
      expect(isSensitiveKey('symbol')).toBe(false);
    });

    it('redacts sensitive fields in nested objects', () => {
      const sensitiveInput = {
        email: 'trader@cex.io',
        password: 'super-secret-password',
        headers: {
          authorization: 'Bearer token123',
          cookie: 'session=xyz',
          host: 'cex.io',
        },
        profile: {
          apiKey: 'key_abc',
          name: 'Trader Joe',
        },
      };

      const result = redactSensitiveData(sensitiveInput) as typeof sensitiveInput;

      expect(result.email).toBe('trader@cex.io');
      expect(result.password).toBe('[REDACTED]');
      expect(result.headers.authorization).toBe('[REDACTED]');
      expect(result.headers.cookie).toBe('[REDACTED]');
      expect(result.headers.host).toBe('cex.io');
      expect(result.profile.apiKey).toBe('[REDACTED]');
      expect(result.profile.name).toBe('Trader Joe');
    });

    it('handles circular references gracefully without throwing', () => {
      const circularObj: Record<string, unknown> = { name: 'test' };
      circularObj.self = circularObj;

      const result = redactSensitiveData(circularObj) as Record<string, unknown>;
      expect(result.name).toBe('test');
      expect(result.self).toBe('[CIRCULAR]');
    });
  });

  describe('API Logger (apilogs.ts)', () => {
    it('creates API logger with default meta', () => {
      const apiLogger = createApiLogger({ enableFile: false });
      expect(apiLogger).toBeDefined();
      expect(apiLogger.defaultMeta).toMatchObject({ service: 'api-gateway', type: 'api' });
    });

    it('logs normal API request at info level', () => {
      const testLogger = createApiLogger({ enableFile: false });
      const logSpy = vi.spyOn(testLogger, 'log');

      logApiRequest(
        {
          method: 'GET',
          url: '/api/v1/healthz',
          statusCode: 200,
          durationMs: 15,
          requestId: 'req-001',
        },
        testLogger,
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const callArg = logSpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(callArg.level).toBe('info');
      expect(callArg.method).toBe('GET');
      expect(callArg.url).toBe('/api/v1/healthz');
      expect(callArg.statusCode).toBe(200);
      expect(callArg.durationMs).toBe(15);
      expect(callArg.isSlow).toBe(false);
      expect(callArg.message).toContain('GET /api/v1/healthz 200 (15ms)');
    });

    it('warns when request duration exceeds 200ms slow-request threshold', () => {
      const testLogger = createApiLogger({ enableFile: false });
      const logSpy = vi.spyOn(testLogger, 'log');

      logApiRequest(
        {
          method: 'POST',
          url: '/api/v1/orders',
          statusCode: 201,
          durationMs: 250,
          requestId: 'req-slow-1',
          userId: 'user-999',
        },
        testLogger,
        DEFAULT_SLOW_THRESHOLD_MS,
      );

      expect(logSpy).toHaveBeenCalledTimes(1);
      const callArg = logSpy.mock.calls[0]![0] as unknown as Record<string, unknown>;
      expect(callArg.level).toBe('warn');
      expect(callArg.isSlow).toBe(true);
      expect(callArg.message).toContain('[SLOW REQUEST > 200ms]');
    });
  });

  describe('Error Logger (errorlogs.ts)', () => {
    it('creates error logger with error level', () => {
      const errLogger = createErrorLogger({ enableFile: false });
      expect(errLogger).toBeDefined();
      expect(errLogger.level).toBe('error');
      expect(errLogger.defaultMeta).toMatchObject({ service: 'error-handler', type: 'error' });
    });

    it('captures full Error object stack, message, code, and context', () => {
      const errLogger = createErrorLogger({ serviceName: 'db-worker', enableFile: false });
      const errorSpy = vi.spyOn(errLogger, 'error');

      const customError = new Error('Database connection failed');
      (customError as unknown as { code: string; statusCode: number }).code = 'DB_TIMEOUT';
      (customError as unknown as { code: string; statusCode: number }).statusCode = 503;

      logError(
        customError,
        {
          requestId: 'req-err-456',
          userId: 'user-789',
          service: 'db-worker',
        },
        errLogger,
      );

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const errorCall = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(errorCall.message).toBe('Database connection failed');
      expect(errorCall.code).toBe('DB_TIMEOUT');
      expect(errorCall.statusCode).toBe(503);
      expect(errorCall.requestId).toBe('req-err-456');
      expect(errorCall.userId).toBe('user-789');
      expect(errorCall.service).toBe('db-worker');
      expect(typeof errorCall.stack).toBe('string');
    });

    it('handles non-Error objects and string messages', () => {
      const errLogger = createErrorLogger({ serviceName: 'db-worker', enableFile: false });
      const errorSpy = vi.spyOn(errLogger, 'error');

      logError('Plain error string', { code: 'CUSTOM_FAIL' }, errLogger);

      expect(errorSpy).toHaveBeenCalledTimes(1);
      const errorCall = errorSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(errorCall.message).toBe('Plain error string');
      expect(errorCall.code).toBe('CUSTOM_FAIL');
    });
  });

  describe('Debug Logger (debuglogs.ts)', () => {
    it('creates debug logger with debug level', () => {
      const dbgLogger = createDebugLogger({ enableFile: false });
      expect(dbgLogger).toBeDefined();
      expect(dbgLogger.level).toBe('debug');
      expect(dbgLogger.defaultMeta).toMatchObject({ service: 'debugger', type: 'debug' });
    });

    it('logs debug messages with context', () => {
      const dbgLogger = createDebugLogger({ enableFile: false });
      const debugSpy = vi.spyOn(dbgLogger, 'debug');

      logDebug('Replaying journal sequence', { engineSeq: 1050, market: 'BTC-USDT' }, dbgLogger);

      expect(debugSpy).toHaveBeenCalledTimes(1);
      expect(debugSpy).toHaveBeenCalledWith(
        'Replaying journal sequence',
        expect.objectContaining({ engineSeq: 1050, market: 'BTC-USDT' }),
      );
    });
  });

  describe('Startup Banner (banner.ts)', () => {
    it('formats a development banner box with services, routes, and dependencies', () => {
      const banner = formatStartupBanner({
        serviceName: '@cex/api-gateway',
        title: '🚀 KAIROS CEX : API GATEWAY',
        environment: 'development',
        host: '0.0.0.0',
        port: 4000,
        baseUrl: 'http://localhost:4000',
        healthUrl: 'http://localhost:4000/api/v1/healthz',
        dependencies: [
          { name: 'PostgreSQL 16', status: 'connected' },
          { name: 'Redis 7', status: 'connected' },
        ],
        routes: [
          { method: 'GET', path: '/api/v1/healthz' },
          { method: 'POST', path: '/api/v1/auth/signup' },
        ],
      });

      expect(banner).toContain('🚀 KAIROS CEX : API GATEWAY');
      expect(banner).toContain('0.0.0.0:4000');
      expect(banner).toContain('http://localhost:4000/api/v1/healthz');
      expect(banner).toContain('🟢 PostgreSQL 16');
      expect(banner).toContain('🟢 Redis 7');
      expect(banner).toContain('GET    /api/v1/healthz');
      expect(banner).toContain('POST   /api/v1/auth/signup');
      expect(banner).toContain('┌');
      expect(banner).toContain('└');
    });

    it('formats a worker banner without HTTP routes', () => {
      const banner = formatStartupBanner({
        serviceName: '@cex/engine',
        title: '⚙️ KAIROS CEX : MATCHING ENGINE',
        serviceType: 'worker',
        streams: ['orders:stream', 'trades:stream'],
        dependencies: [{ name: 'Redis 7', status: 'connected' }],
      });

      expect(banner).toContain('⚙️ KAIROS CEX : MATCHING ENGINE');
      expect(banner).toContain('Background Worker (Event-driven)');
      expect(banner).toContain('orders:stream, trades:stream');
      expect(banner).not.toContain('Available Endpoints:');
    });

    it('prints banner in development without throwing', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printStartupBanner({
        serviceName: '@cex/api-gateway',
        environment: 'development',
        port: 4000,
      });
      expect(consoleSpy).toHaveBeenCalled();
      consoleSpy.mockRestore();
    });

    it('emits structured JSON in production mode', () => {
      const consoleSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
      printStartupBanner({
        serviceName: '@cex/api-gateway',
        environment: 'production',
        port: 4000,
      });
      expect(consoleSpy).toHaveBeenCalledTimes(1);
      const callArg = JSON.parse(consoleSpy.mock.calls[0]![0]);
      expect(callArg.event).toBe('SERVICE_STARTUP');
      expect(callArg.service).toBe('@cex/api-gateway');
      expect(callArg.port).toBe(4000);
      consoleSpy.mockRestore();
    });
  });
});
