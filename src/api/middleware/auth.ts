import type { FastifyRequest, FastifyReply } from 'fastify';
import { extractBearerToken, verifyAccessToken } from '../../shared/jwt.ts';
import type { AccessTokenClaims } from '../../shared/jwt.ts';
import { unauthorized } from '../../shared/errors.ts';

declare module 'fastify' {
  interface FastifyRequest {
    user?: AccessTokenClaims;
  }
}

/**
 * preHandler olarak kullanılır:
 *   app.get('/api/auth/me', { preHandler: requireAuth }, handler)
 */
export async function requireAuth(req: FastifyRequest, _reply: FastifyReply): Promise<void> {
  const token = extractBearerToken(req.headers.authorization);
  if (!token) {
    throw unauthorized('Authorization başlığı eksik veya hatalı biçimde');
  }
  req.user = await verifyAccessToken(token);
}

/** Doğrulanmış kullanıcıyı tip güvenli şekilde alır. */
export function currentUser(req: FastifyRequest): AccessTokenClaims {
  if (!req.user) {
    // Buraya düşmek requireAuth'u eklemeyi unuttuğunuz anlamına gelir.
    throw unauthorized();
  }
  return req.user;
}
