import { randomBytes, createHash } from 'node:crypto';

import { redis } from './redis.ts';

// Tarayıcının WebSocket API'si özel başlık göndermeye izin vermediği için
// sırrı query string'de taşımak zorundayız. Ham JWT yerine 30 saniyelik,
// tek kullanımlık, tek odaya kilitli bir bilet veriyoruz — loglara düşse bile
// kısa sürede değersizleşir.

const TTL_SECONDS = 30;

export type TicketPayload = {
  userId: string;
  displayName: string;
  slug: string;
};

// Redis'te ham bilet değil özeti durur.
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

// GETDEL atomik: "GET sonra DEL" yazsaydık aynı bileti iki bağlantı
// aynı anda kullanabilirdi.
export async function consumeTicket(ticket: string): Promise<TicketPayload | null> {
  const raw = await redis.getdel(keyFor(ticket));
  if (!raw) return null;
  try {
    return JSON.parse(raw) as TicketPayload;
  } catch {
    return null;
  }
}
