import { z } from 'zod';

/**
 * WebSocket protokolü — SUNUCU tarafı.
 *
 * Saf çekirdek (tipler, sabitler, drift/saat matematiği) `protocol-core.ts`
 * içindedir ve esbuild ile tarayıcıya da servis edilir. Bu dosya onun üstüne
 * çalışma anı DOĞRULAMA şemalarını ekler; şemalar yalnızca sunucuda gerekir
 * çünkü istemci girdisi düşman girdisidir.
 *
 * Tasarımın iki temel kuralı:
 *
 * 1) SUNUCU TEK OTORİTEDİR. İstemci "oynat" diye komut gönderir, kendi
 *    state'ini değiştirmez. Sunucu kabul eder, versiyonu artırır, herkese
 *    yayınlar. İstemci yalnızca sunucudan gelen state'i uygular.
 *
 * 2) HER STATE DEĞİŞİKLİĞİ VERSİYONU ARTIRIR. İstemci, kendi gördüğünden
 *    küçük veya eşit versiyonlu bir STATE alırsa YOKSAYAR. Bu tek kural
 *    iki ayrı problemi çözer:
 *      - ağdan sırasız gelen mesajlar (out-of-order delivery)
 *      - iki kullanıcının aynı anda PAUSE basması (deterministik son-yazan-kazanır)
 */

export * from './protocol-core.ts';
import type { Member, PlaybackState } from './protocol-core.ts';

// ----------------------------------------------------------------- Kaynak
export const SourceRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('youtube'), videoId: z.string().regex(/^[\w-]{11}$/) }),
  z.object({ type: z.literal('hls'), url: z.string().url() }),
]);

// -------------------------------------------------------- İstemci → Sunucu
export const ClientMessageSchema = z.discriminatedUnion('type', [
  /** Saat senkronu. t0 = istemcinin gönderim anı (istemci saati). */
  z.object({ type: z.literal('PING'), t0: z.number() }),

  z.object({ type: z.literal('PLAY'), positionMs: z.number().min(0).optional() }),
  z.object({ type: z.literal('PAUSE'), positionMs: z.number().min(0).optional() }),
  z.object({ type: z.literal('SEEK'), positionMs: z.number().min(0) }),

  /** Yalnızca host. Kaynak değişimi state'i sıfırlar. */
  z.object({ type: z.literal('SET_SOURCE'), source: SourceRefSchema }),

  /** İstemcinin kendi sapmasını bildirmesi — metrik ve teşhis için. */
  z.object({
    type: z.literal('HEARTBEAT'),
    positionMs: z.number().min(0),
    driftMs: z.number(),
  }),

  z.object({ type: z.literal('CHAT'), text: z.string().trim().min(1).max(500) }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// -------------------------------------------------------- Sunucu → İstemci
export type ServerMessage =
  | {
      type: 'HELLO';
      you: { userId: string; displayName: string };
      room: { slug: string; name: string };
      state: PlaybackState;
      members: Member[];
      serverTimeMs: number;
    }
  /** t1 = sunucu alım anı, t2 = sunucu gönderim anı (ikisi de sunucu saati). */
  | { type: 'PONG'; t0: number; t1: number; t2: number }
  | { type: 'STATE'; state: PlaybackState; byUserId: string | null; reason: string }
  | { type: 'PRESENCE'; members: Member[] }
  | { type: 'CHAT'; userId: string; displayName: string; text: string; atMs: number }
  /** Faz 4: transkod ilerlemesi artık yoklanmıyor, itiliyor. */
  | {
      type: 'VIDEO_PROGRESS';
      videoId: string;
      status: 'queued' | 'processing' | 'ready' | 'failed';
      percent: number | null;
      errorMessage?: string;
    }
  | { type: 'ERROR'; code: string; message: string };
