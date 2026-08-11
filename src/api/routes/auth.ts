import type { FastifyInstance } from 'fastify';
import { z } from 'zod';

import { queryOne, isUniqueViolation } from '../../shared/db.ts';
import { hashPassword, verifyPassword, fakeVerify } from '../../shared/password.ts';
import { signAccessToken } from '../../shared/jwt.ts';
import { issueRefreshToken, rotateRefreshToken, revokeFamilyOf } from '../../shared/refresh.ts';
import { config } from '../../shared/config.ts';
import { badRequest, conflict, unauthorized, notFound } from '../../shared/errors.ts';
import { requireAuth, currentUser } from '../middleware/auth.ts';

// `type` kullanıyoruz (interface değil): pg'nin QueryResultRow kısıtı örtük
// index imzası gerektirir ve bunu yalnızca type alias'lar sağlar.
type UserRow = {
  id: string;
  email: string;
  display_name: string;
  password_hash: string;
  created_at: Date;
};

const RegisterSchema = z.object({
  email: z.string().trim().toLowerCase().max(254).email('Geçerli bir e-posta adresi girin'),
  password: z
    .string()
    .min(8, 'Parola en az 8 karakter olmalı')
    .max(200, 'Parola en fazla 200 karakter olabilir'),
  displayName: z.string().trim().min(1, 'Görünen ad boş olamaz').max(64),
});

const LoginSchema = z.object({
  email: z.string().trim().toLowerCase().max(254),
  password: z.string().min(1).max(200),
});

// Jeton 32 baytın base64url'ü = 43 karakter. Üst sınır, gövdeyi şişirip
// boşuna SHA-256 hesaplatmayı engelliyor.
const RefreshSchema = z.object({
  refreshToken: z.string().min(20).max(200),
});

function parseBody<S extends z.ZodTypeAny>(schema: S, body: unknown): z.infer<S> {
  const result = schema.safeParse(body);
  if (!result.success) {
    throw badRequest(
      'İstek gövdesi geçersiz',
      result.error.issues.map((i) => ({
        field: i.path.join('.') || '(kök)',
        message: i.message,
      })),
    );
  }
  return result.data;
}

function toPublicUser(row: Pick<UserRow, 'id' | 'email' | 'display_name' | 'created_at'>) {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    createdAt: row.created_at,
  };
}

export async function registerAuthRoutes(app: FastifyInstance): Promise<void> {
  // -------------------------------------------------------------- register
  app.post('/register', async (req, reply) => {
    const { email, password, displayName } = parseBody(RegisterSchema, req.body);

    const passwordHash = await hashPassword(password);

    let row: UserRow | null;
    try {
      row = await queryOne<UserRow>(
        `INSERT INTO users (email, password_hash, display_name)
         VALUES ($1, $2, $3)
         RETURNING id, email, display_name, password_hash, created_at`,
        [email, passwordHash, displayName],
      );
    } catch (err) {
      // Yarış durumu: iki istek aynı anda aynı e-postayla gelebilir. Önce
      // SELECT yapıp sonra INSERT etmek bu yarışı KAPATMAZ; benzersizlik
      // kısıtının ihlalini yakalamak tek doğru yoldur.
      if (isUniqueViolation(err)) {
        throw conflict('Bu e-posta adresi zaten kayıtlı');
      }
      throw err;
    }

    if (!row) throw new Error('INSERT ... RETURNING satır döndürmedi');

    const accessToken = await signAccessToken({
      sub: row.id,
      email: row.email,
      displayName: row.display_name,
    });

    const refresh = await issueRefreshToken(row.id);

    req.log.info({ userId: row.id }, 'Yeni kullanıcı kaydı');

    return reply.status(201).send({
      user: toPublicUser(row),
      accessToken,
      expiresIn: config.ACCESS_TOKEN_TTL,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresInSeconds,
    });
  });

  // ----------------------------------------------------------------- login
  app.post('/login', async (req, reply) => {
    const { email, password } = parseBody(LoginSchema, req.body);

    const row = await queryOne<UserRow>(
      `SELECT id, email, display_name, password_hash, created_at
         FROM users
        WHERE email_norm = lower($1)`,
      [email],
    );

    if (!row) {
      // Kullanıcı yoksa da bir parola doğrulaması kadar zaman harcıyoruz.
      // Aksi hâlde yanıt süresi farkı "bu e-posta kayıtlı mı?" bilgisini
      // sızdırır (user enumeration).
      await fakeVerify();
      throw unauthorized('E-posta veya parola hatalı');
    }

    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) {
      // Hangi alanın yanlış olduğunu ASLA söylemeyin — aynı genel mesaj.
      throw unauthorized('E-posta veya parola hatalı');
    }

    const accessToken = await signAccessToken({
      sub: row.id,
      email: row.email,
      displayName: row.display_name,
    });

    const refresh = await issueRefreshToken(row.id);

    req.log.info({ userId: row.id }, 'Giriş başarılı');

    return reply.send({
      user: toPublicUser(row),
      accessToken,
      expiresIn: config.ACCESS_TOKEN_TTL,
      refreshToken: refresh.token,
      refreshExpiresIn: refresh.expiresInSeconds,
    });
  });

  // --------------------------------------------------------------- refresh
  //
  // Erişim jetonu İSTEMİYOR — zaten süresi dolduğu için buraya geliniyor.
  app.post('/refresh', async (req, reply) => {
    const { refreshToken } = parseBody(RefreshSchema, req.body);

    const result = await rotateRefreshToken(refreshToken);
    if (!result.ok) {
      if (result.reason === 'reused') {
        // Kullanılmış jetonun ikinci kez sunulması: ortada iki kopya var,
        // biri çalıntı. Aile iptal edildi; istemciye de bunu söylüyoruz ki
        // sessizce yeniden denemesin.
        req.log.warn('Kullanılmış yenileme jetonu sunuldu; aile iptal edildi');
        throw unauthorized('Oturum güvenlik nedeniyle sonlandırıldı, yeniden giriş yapın');
      }
      throw unauthorized('Yenileme jetonu geçersiz veya süresi dolmuş');
    }

    // Kullanıcı silinmiş ya da adını değiştirmiş olabilir; iddiaları
    // veritabanından tazeliyoruz.
    const row = await queryOne<UserRow>(
      `SELECT id, email, display_name, password_hash, created_at
         FROM users WHERE id = $1`,
      [result.userId],
    );
    if (!row) throw unauthorized('Kullanıcı bulunamadı');

    const accessToken = await signAccessToken({
      sub: row.id,
      email: row.email,
      displayName: row.display_name,
    });

    return reply.send({
      user: toPublicUser(row),
      accessToken,
      expiresIn: config.ACCESS_TOKEN_TTL,
      refreshToken: result.token,
      refreshExpiresIn: result.expiresInSeconds,
    });
  });

  // ---------------------------------------------------------------- logout
  //
  // Jetonu değil AİLEYİ kapatıyoruz: elde kalan eski bir halkanın oturumu
  // sürdürebilmesi çıkışı anlamsız kılardı. Bilinmeyen jetona da 204 dönüyoruz;
  // "bu jeton var mıydı" bilgisini sızdırmanın gereği yok.
  app.post('/logout', async (req, reply) => {
    const { refreshToken } = parseBody(RefreshSchema, req.body);
    await revokeFamilyOf(refreshToken);
    return reply.status(204).send();
  });

  // -------------------------------------------------------------------- me
  app.get('/me', { preHandler: requireAuth }, async (req) => {
    const claims = currentUser(req);

    // Token'daki iddialara güvenip doğrudan dönmüyoruz: kullanıcı silinmiş ya
    // da adını değiştirmiş olabilir. Token kimliği taşır, gerçeği değil.
    const row = await queryOne<UserRow>(
      `SELECT id, email, display_name, password_hash, created_at
         FROM users WHERE id = $1`,
      [claims.sub],
    );

    if (!row) throw notFound('Kullanıcı bulunamadı');

    return { user: toPublicUser(row) };
  });
}
