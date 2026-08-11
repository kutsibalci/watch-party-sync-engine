/**
 * Dönen (rotating) yenileme jetonları.
 *
 * Erişim jetonu kısa ömürlü ve iptal edilemez; yenileme jetonu uzun ömürlü ve
 * iptal edilebilir. Her kullanımda yenisiyle DEĞİŞTİRİLİR, yani bir jeton
 * yalnızca bir kez işe yarar.
 *
 * Yeniden kullanım tespiti: değiştirilmiş bir jeton ikinci kez sunulursa
 * ortada iki kopya var demektir — biri çalıntı. Hangisinin çalıntı olduğunu
 * bilemeyiz, o yüzden AİLENİN tamamını iptal ediyoruz. Bedeli, meşru
 * kullanıcının da yeniden giriş yapması; alternatifi, saldırganın oturumu
 * süresiz sürdürmesi.
 *
 * Tek istisna kısa bir tolerans penceresi (REFRESH_REUSE_LEEWAY_MS): saniyeler
 * içinde gelen ikinci kullanım pratikte hep iki sekmenin ya da bir ağ
 * tekrarının aynı jetonu göndermesidir, çalıntı değildir. O pencerede aile
 * kapatılmaz. Gerekçesi ölçülmüş bir olay: istemci yarışı Web Locks ile
 * sıraya sokmasına rağmen CI koşumlarının birinde yarış sızdı.
 */
import { randomBytes, createHash } from 'node:crypto';

import { query, queryOne } from './db.ts';
import { config as cfg } from './config.ts';

/** 32 bayt = 256 bit entropi; tahmin edilemez. */
const TOKEN_BYTES = 32;

type TokenRow = {
  id: string;
  user_id: string;
  family_id: string;
  replaced_at: Date | null;
  revoked_at: Date | null;
  expires_at: Date;
};

function digest(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

export type IssuedRefresh = { token: string; expiresInSeconds: number };

/**
 * Yeni bir aile başlatır (giriş/kayıt) ya da verilen ailenin sıradaki
 * jetonunu üretir (döndürme).
 */
export async function issueRefreshToken(
  userId: string,
  familyId?: string,
): Promise<IssuedRefresh> {
  const token = randomBytes(TOKEN_BYTES).toString('base64url');
  const ttl = cfg.REFRESH_TOKEN_TTL;

  await query(
    `INSERT INTO refresh_tokens (user_id, token_hash, family_id, expires_at)
     VALUES ($1, $2, COALESCE($3::uuid, gen_random_uuid()), now() + make_interval(secs => $4))`,
    [userId, digest(token), familyId ?? null, ttl],
  );

  // Fırsatçı temizlik: süresi geçmiş satırları burada topluyoruz. Ayrı bir
  // zamanlanmış iş kurmak, tabloyu büyüten tek yolun zaten bu uç nokta olduğu
  // bir yerde fazladan hareketli parça demek.
  await query(
    `DELETE FROM refresh_tokens WHERE user_id = $1 AND expires_at < now() - interval '1 day'`,
    [userId],
  );

  return { token, expiresInSeconds: ttl };
}

export type RotateResult =
  | { ok: true; userId: string; token: string; expiresInSeconds: number; leeway?: boolean }
  | { ok: false; reason: 'invalid' | 'reused' };

/**
 * Jetonu tüketip yerine yenisini verir.
 *
 * Tüketme koşullu bir UPDATE ile yapılıyor; iki istek aynı jetonla aynı anda
 * gelirse yalnızca biri satırı alır. Önce SELECT sonra UPDATE yazsaydık ikisi
 * de geçerdi ve tek kullanımlık olma özelliği kâğıt üstünde kalırdı.
 */
export async function rotateRefreshToken(token: string): Promise<RotateResult> {
  const hash = digest(token);

  const claimed = await queryOne<TokenRow>(
    `UPDATE refresh_tokens
        SET replaced_at = now()
      WHERE token_hash = $1
        AND replaced_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      RETURNING id, user_id, family_id, replaced_at, revoked_at, expires_at`,
    [hash],
  );

  if (claimed) {
    const next = await issueRefreshToken(claimed.user_id, claimed.family_id);
    return { ok: true, userId: claimed.user_id, ...next };
  }

  // Alınamadı: ya hiç yok, ya süresi geçmiş, ya iptal edilmiş — ya da ZATEN
  // KULLANILMIŞ. Sonuncusu diğerlerinden farklı bir olay.
  const existing = await queryOne<TokenRow & { since_ms: number }>(
    `SELECT id, user_id, family_id, replaced_at, revoked_at, expires_at,
            EXTRACT(EPOCH FROM (now() - replaced_at)) * 1000 AS since_ms
       FROM refresh_tokens WHERE token_hash = $1`,
    [hash],
  );

  if (existing && existing.replaced_at && !existing.revoked_at && existing.expires_at > new Date()) {
    /**
     * Kısa aralıkla gelen ikinci kullanım çalıntı değil, YARIŞTIR.
     *
     * İki sekme aynı anda yeniliyor ya da ağ isteği tekrarlıyor. İstemci bunu
     * Web Locks ile sıraya sokuyor ama garanti veremez; CI'da altı koşumun
     * birinde yarış sızdı ve kullanıcı kendi kendini çıkışa attı. Bu pencere
     * içinde aileyi kapatmıyor, kaybedene de geçerli bir jeton veriyoruz.
     *
     * Bedeli açık: bu saniyeler içinde çalıntı bir kopya da bir kez
     * kullanılabilir. Karşılığında film ortasında kimse çıkışa düşmüyor.
     */
    if (existing.since_ms <= cfg.REFRESH_REUSE_LEEWAY_MS) {
      const next = await issueRefreshToken(existing.user_id, existing.family_id);
      return { ok: true, userId: existing.user_id, ...next, leeway: true };
    }
    await revokeFamily(existing.family_id);
    return { ok: false, reason: 'reused' };
  }

  return { ok: false, reason: 'invalid' };
}

/** Çıkışta: bu jetonun ailesini komple kapat, sadece jetonu değil. */
export async function revokeFamilyOf(token: string): Promise<boolean> {
  const row = await queryOne<TokenRow>(
    `SELECT id, user_id, family_id, replaced_at, revoked_at, expires_at
       FROM refresh_tokens WHERE token_hash = $1`,
    [digest(token)],
  );
  if (!row) return false;
  await revokeFamily(row.family_id);
  return true;
}

export async function revokeFamily(familyId: string): Promise<void> {
  await query(
    `UPDATE refresh_tokens SET revoked_at = now()
      WHERE family_id = $1 AND revoked_at IS NULL`,
    [familyId],
  );
}
