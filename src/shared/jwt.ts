import { SignJWT, jwtVerify, errors as joseErrors } from 'jose';
import { config } from './config.ts';
import { unauthorized } from './errors.ts';

const secret = new TextEncoder().encode(config.JWT_SECRET);
const ALG = 'HS256';

export type AccessTokenClaims = {
  sub: string;          // user id
  email: string;
  displayName: string;
};

export async function signAccessToken(claims: AccessTokenClaims): Promise<string> {
  return new SignJWT({ email: claims.email, displayName: claims.displayName })
    .setProtectedHeader({ alg: ALG })
    .setSubject(claims.sub)
    .setIssuer(config.JWT_ISSUER)
    .setAudience('watchparty-api')
    .setIssuedAt()
    .setExpirationTime(`${config.ACCESS_TOKEN_TTL}s`)
    .sign(secret);
}

export async function verifyAccessToken(token: string): Promise<AccessTokenClaims> {
  try {
    const { payload } = await jwtVerify(token, secret, {
      issuer: config.JWT_ISSUER,
      audience: 'watchparty-api',
      algorithms: [ALG],   // algoritma karıştırma saldırısına karşı beyaz liste
    });

    if (typeof payload.sub !== 'string') {
      throw unauthorized('Token içinde geçerli bir özne (sub) yok');
    }

    return {
      sub: payload.sub,
      email: typeof payload.email === 'string' ? payload.email : '',
      displayName: typeof payload.displayName === 'string' ? payload.displayName : '',
    };
  } catch (err) {
    if (err instanceof joseErrors.JWTExpired) {
      throw unauthorized('Oturum süresi doldu');
    }
    if (err instanceof joseErrors.JOSEError) {
      throw unauthorized('Geçersiz token');
    }
    throw err;
  }
}

/** "Authorization: Bearer <token>" başlığından token'ı ayıklar. */
export function extractBearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
