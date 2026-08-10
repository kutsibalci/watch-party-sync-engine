import { z } from 'zod';

/**
 * WebSocket protokolü, sunucu tarafı.
 *
 * Saf çekirdek protocol-core.ts'te ve tarayıcıya da derleniyor. Buradaki
 * doğrulama şemaları yalnızca sunucuda gerekli: istemci girdisi güvenilmez.
 *
 * İki kural protokolün tamamını taşıyor:
 *  - Otorite sunucudadır. İstemci komut gönderir, kendi durumunu değiştirmez.
 *  - Her değişiklik sürümü artırır; istemci kendi gördüğünden eski bir durum
 *    alırsa yoksayar. Sırasız paketler ve eşzamanlı komutlar böyle çözülüyor.
 */

export * from './protocol-core.ts';
import type { MediaFlags, Member, PlaybackState } from './protocol-core.ts';

export const SourceRefSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('youtube'), videoId: z.string().regex(/^[\w-]{11}$/) }),
  z.object({ type: z.literal('hls'), url: z.string().url() }),
]);

// ─────────────────────────────────────────────────────── İstemci → Sunucu
export const ClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('PING'), t0: z.number() }),

  z.object({ type: z.literal('PLAY'), positionMs: z.number().min(0).optional() }),
  z.object({ type: z.literal('PAUSE'), positionMs: z.number().min(0).optional() }),
  z.object({ type: z.literal('SEEK'), positionMs: z.number().min(0) }),

  // Yalnızca host; kaynak değişimi durumu sıfırlar.
  z.object({ type: z.literal('SET_SOURCE'), source: SourceRefSchema }),

  z.object({
    type: z.literal('HEARTBEAT'),
    positionMs: z.number().min(0),
    driftMs: z.number(),
  }),

  z.object({ type: z.literal('CHAT'), text: z.string().trim().min(1).max(500) }),

  // WebRTC sinyalleşmesi. Sunucu içeriğe bakmaz, hedef bağlantıya iletir.
  // 64 KB sınırı SDP için fazlasıyla yeterli ve kanalı kötüye kullanmayı zorlaştırır.
  z.object({
    type: z.literal('RTC_SIGNAL'),
    to: z.string().uuid(),
    payload: z.string().max(64 * 1024),
  }),

  z.object({
    type: z.literal('RTC_MEDIA'),
    mic: z.boolean(),
    cam: z.boolean(),
    screen: z.boolean(),
  }),
]);
export type ClientMessage = z.infer<typeof ClientMessageSchema>;

// ─────────────────────────────────────────────────────── Sunucu → İstemci
export type ServerMessage =
  | {
      type: 'HELLO';
      you: { userId: string; displayName: string; connectionId: string };
      room: { slug: string; name: string };
      state: PlaybackState;
      members: Member[];
      serverTimeMs: number;
    }
  // t1 = sunucu alım anı, t2 = sunucu gönderim anı.
  | { type: 'PONG'; t0: number; t1: number; t2: number }
  | { type: 'STATE'; state: PlaybackState; byUserId: string | null; reason: string }
  | { type: 'PRESENCE'; members: Member[] }
  | { type: 'CHAT'; userId: string; displayName: string; text: string; atMs: number }
  | {
      type: 'VIDEO_PROGRESS';
      videoId: string;
      status: 'queued' | 'processing' | 'ready' | 'failed';
      percent: number | null;
      errorMessage?: string;
    }
  | { type: 'RTC_SIGNAL'; from: string; fromName: string; payload: string }
  | { type: 'RTC_MEDIA'; connectionId: string; media: MediaFlags }
  | { type: 'ERROR'; code: string; message: string };

// ─────────────────────────────────────────── Ortak tarayıcı (ayrı servis)
//
// Bu mesajlar senkron motorundan geçmez; istemci ile tarayıcı servisi
// arasındaki ayrı WebSocket üzerinde konuşulur. Girdi olayları sunucudaki
// gerçek bir Chrome sekmesine basıldığı için şema burada da dar tutuluyor.

const MOUSE_KINDS = ['mousePressed', 'mouseReleased', 'mouseMoved', 'mouseWheel'] as const;
const KEY_KINDS = ['keyDown', 'keyUp', 'char'] as const;

export const BrowserClientMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('BROWSER_START'), url: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('BROWSER_NAV'), url: z.string().min(1).max(2048) }),
  z.object({ type: z.literal('BROWSER_STOP') }),
  // Geri/ileri/yenile olmayan bir tarayıcı yarım tarayıcıdır.
  z.object({ type: z.literal('BROWSER_BACK') }),
  z.object({ type: z.literal('BROWSER_FORWARD') }),
  z.object({ type: z.literal('BROWSER_RELOAD') }),

  z.object({
    type: z.literal('BROWSER_MOUSE'),
    kind: z.enum(MOUSE_KINDS),
    // Görüntü ölçeklenebildiği için istemci sahne koordinatı değil, sayfanın
    // kendi koordinatını gönderir.
    x: z.number().finite(),
    y: z.number().finite(),
    button: z.enum(['none', 'left', 'middle', 'right']).optional(),
    deltaX: z.number().finite().optional(),
    deltaY: z.number().finite().optional(),
  }),

  z.object({
    type: z.literal('BROWSER_KEY'),
    kind: z.enum(KEY_KINDS),
    key: z.string().max(32).optional(),
    code: z.string().max(32).optional(),
    text: z.string().max(8).optional(),
    keyCode: z.number().int().min(0).max(255).optional(),
  }),
]);
export type BrowserClientMessage = z.infer<typeof BrowserClientMessageSchema>;
