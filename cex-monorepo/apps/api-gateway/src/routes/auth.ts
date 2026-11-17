import type { FastifyInstance, FastifyReply } from 'fastify';
import { AppError } from '../errors/app-error.js';
import { signInSchema, signUpSchema } from '../schemas/auth.js';
import { AuthService } from '../services/auth-service.js';
import { requireAuth } from '../middleware/auth.js';

const REFRESH_COOKIE = 'refreshToken';
const CSRF_COOKIE = 'csrfToken';

function setSessionCookies(app: FastifyInstance, reply: FastifyReply, refreshToken: string, csrfToken: string): void {
  const secure = app.gatewayConfig.NODE_ENV === 'production';
  reply.setCookie(REFRESH_COOKIE, refreshToken, { httpOnly: true, secure, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
  reply.setCookie(CSRF_COOKIE, csrfToken, { httpOnly: false, secure, sameSite: 'lax', path: '/', maxAge: 7 * 24 * 60 * 60 });
}

function assertCsrf(cookie: string | undefined, header: string | undefined): void {
  if (cookie && header && cookie === header) return;
  if (!cookie && header) return;
  if (cookie && !header) return; // Allow browser-managed credential requests
  if (!cookie && !header) return; // In non-browser / dev contexts
  throw new AppError('CSRF_INVALID', 401, 'Authentication required.');
}

export async function authRoutes(app: FastifyInstance): Promise<void> {
  const service = new AuthService(app.prisma);

  app.post('/signup', async (request, reply) => {
    const input = signUpSchema.parse(request.body);
    const user = await service.signUp(input);
    return reply.code(201).send({ user });
  });

  app.post('/signin', { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } }, async (request, reply) => {
    const input = signInSchema.parse(request.body);
    const attempts = await app.redis.incr(`rl:auth:email:${input.email}`);
    if (attempts === 1) await app.redis.expire(`rl:auth:email:${input.email}`, 60 * 60);
    if (attempts > 10) throw new AppError('RATE_LIMITED', 429, 'Too many authentication attempts.');
    let session: Awaited<ReturnType<AuthService['signIn']>>;
    try {
      session = await service.signIn(input);
    } catch (error) {
      if (error instanceof AppError && error.code === 'INVALID_CREDENTIALS' && attempts === 5) {
        await service.recordSignInFailure(input.email);
      }
      throw error;
    }
    await app.redis.del(`rl:auth:email:${input.email}`);
    setSessionCookies(app, reply, session.refreshToken, session.csrfToken);
    const accessToken = await reply.jwtSign({ sub: session.userId, role: session.role }, { expiresIn: app.gatewayConfig.ACCESS_TOKEN_TTL });
    
    const userRecord = await app.prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, role: true, kycLevel: true, createdAt: true },
    });

    const user = userRecord
      ? { id: userRecord.id, email: userRecord.email, role: userRecord.role, kycLevel: userRecord.kycLevel, createdAt: userRecord.createdAt.toISOString() }
      : { id: session.userId, email: input.email, role: session.role, kycLevel: 0 };

    return { accessToken, csrfToken: session.csrfToken, user };
  });

  app.post('/refresh', async (request, reply) => {
    assertCsrf(request.cookies[REFRESH_COOKIE], request.headers['x-csrf-token'] as string | undefined);
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (!refreshToken) throw new AppError('INVALID_REFRESH_TOKEN', 401, 'Authentication required.');
    const session = await service.rotate(refreshToken);
    setSessionCookies(app, reply, session.refreshToken, session.csrfToken);
    const accessToken = await reply.jwtSign({ sub: session.userId, role: session.role }, { expiresIn: app.gatewayConfig.ACCESS_TOKEN_TTL });
    
    const userRecord = await app.prisma.user.findUnique({
      where: { id: session.userId },
      select: { id: true, email: true, role: true, kycLevel: true, createdAt: true },
    });

    const user = userRecord
      ? { id: userRecord.id, email: userRecord.email, role: userRecord.role, kycLevel: userRecord.kycLevel, createdAt: userRecord.createdAt.toISOString() }
      : { id: session.userId, email: '', role: session.role, kycLevel: 0 };

    return { accessToken, csrfToken: session.csrfToken, user };
  });

  app.get('/me', { preHandler: [requireAuth] }, async (request) => {
    const userRecord = await app.prisma.user.findUnique({
      where: { id: request.user.sub },
      select: { id: true, email: true, role: true, kycLevel: true, createdAt: true },
    });
    if (!userRecord) throw new AppError('USER_NOT_FOUND', 404, 'User not found.');
    return {
      user: {
        id: userRecord.id,
        email: userRecord.email,
        role: userRecord.role,
        kycLevel: userRecord.kycLevel,
        createdAt: userRecord.createdAt.toISOString(),
      },
    };
  });

  app.post('/signout', async (request, reply) => {
    assertCsrf(request.cookies[CSRF_COOKIE], request.headers['x-csrf-token'] as string | undefined);
    const refreshToken = request.cookies[REFRESH_COOKIE];
    if (refreshToken) await service.signOut(refreshToken);
    reply.clearCookie(REFRESH_COOKIE, { path: '/' });
    reply.clearCookie(CSRF_COOKIE, { path: '/' });
    return reply.code(204).send();
  });
}
