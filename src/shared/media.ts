import { config } from './config.ts';

/**
 * Medya anahtar düzeni ve genel URL üretimi.
 *
 * Bu modül BİLİNÇLİ olarak `storage.ts`'ten ayrıdır: yalnızca adres bilgisi
 * kullanır, S3 kimlik bilgisi İSTEMEZ. Böylece realtime servisi HLS URL'i
 * üretebilirken storage yetkilerine hiç sahip olmaz (en az yetki ilkesi).
 */

/** Bu önek altındaki nesneler anonim okumaya açıktır (minio-init ayarlar). */
export const PUBLIC_PREFIX = 'public';

export const keys = {
  /** Ham yükleme — GENEL DEĞİL, yalnızca sunucu erişir. */
  source: (videoId: string, ext: string) => `uploads/${videoId}/source${ext}`,
  hlsDir: (videoId: string) => `${PUBLIC_PREFIX}/hls/${videoId}`,
  hlsMaster: (videoId: string) => `${PUBLIC_PREFIX}/hls/${videoId}/master.m3u8`,
};

/**
 * Tarayıcının doğrudan çekebileceği URL.
 * Yalnızca PUBLIC_PREFIX altındaki anahtarlar için anlamlıdır.
 */
export function publicUrl(key: string): string {
  return `${config.S3_PUBLIC_ENDPOINT.replace(/\/$/, '')}/${config.S3_BUCKET}/${key}`;
}

/**
 * Kullanıcıya özel olay kanalı.
 *
 * Oda kanalı (`room:{slug}`) odadaki HERKESE yayın yapar; transkod ilerlemesi
 * ise yalnızca videoyu yükleyeni ilgilendirir. Faz 3'te kurduğumuz Pub/Sub
 * altyapısını burada yeniden kullanıyoruz — worker yayınlar, kullanıcının
 * bağlı olduğu realtime instance'ı dinler ve iletir.
 */
export const userChannel = (userId: string) => `user:${userId}`;

export type UserEvent = {
  kind: 'VIDEO_PROGRESS';
  videoId: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  percent: number | null;
  errorMessage?: string;
};
