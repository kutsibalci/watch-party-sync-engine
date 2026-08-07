import { randomBytes, createHash } from 'node:crypto';

import { redis } from './redis.ts';

/**
 * WebSocket bağlantısı için TEK KULLANIMLIK, KISA ÖMÜRLÜ bilet.
 *
 * ┌─ ÇÖZDÜĞÜ PROBLEM ────────────────────────────────────────────────────────┐
 * │ Tarayıcının WebSocket API'si özel HTTP başlığı göndermeye izin vermez;   │
 * │ `Authorization: Bearer` kullanamayız. Faz 1-3'te JWT'yi query string'de  │
 * │ taşıyorduk. Bunun bedeli gerçek:                                         │
 * │   • query string sunucu ve ters proxy erişim loglarına DÜŞER             │
 * │   • tarayıcı geçmişine ve Referer başlığına sızabilir                    │
 * │   • JWT 15 dakika geçerli — sızarsa 15 dakika kullanılabilir             │
 * │                                                                           │
 * │ Bilet bunu üç şekilde daraltır:                                          │
 * │   • 30 saniye yaşar                                                       │
 * │   • BİR KEZ kullanılır (atomik GETDEL)                                   │
 * │   • yalnızca tek bir odaya bağlanma yetkisi taşır                        │
 * └───────────────────────────────────────────────────────────────────────────┘
 */

const TTL_SECONDS = 30;

export type TicketPayload = {
  userId: string;
  displayName: string;
  slug: string;
};

/** Redis'te ham bilet değil, ÖZETİ saklanır — veritabanı sızarsa bilet çalışmaz. */
function keyFor(ticket: string): string {
  const digest = createHash('sha256').update(ticket).digest('base64url');
  return `wsticket:${digest}`;
}

export async function issueTicket(payload: TicketPayload): Promise<{
  ticket: string;
  expiresInSeconds: number;
}> {
  const ticket = randomBytes(32).toString('base64url');
  await redis.set(keyFor(ticket), JSON.stringify(payload), 'EX', TTL_SECONDS);
  return { ticket, expiresInSeconds: TTL_SECONDS };
}

/**
 * Bileti tüketir. İkinci çağrı null döner.
 *
 * GETDEL atomiktir: "önce GET, sonra DEL" yazsaydık aynı bileti iki bağlantı
 * aynı anda kullanabilirdi. Tek kullanımlık olmasının anlamı kalmazdı.
 */
export async function consumeTicket(ticket: string): Promise<TicketPayload | null> {
  const raw = await redis.getdel(keyFor(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketPayload;
  } catch {
    return null;
  }
}
