import { config } from './config.ts';

// Anahtar düzeni ve genel URL üretimi. storage.ts'ten ayrı tutuluyor çünkü
// burası yalnızca adres bilgisi ister, S3 kimlik bilgisi istemez — realtime
// servisi HLS adresi üretebilsin ama depoya yazma yetkisi almasın diye.

// Bu önek altındaki nesneler anonim okumaya açık (minio-init ayarlar).
export const PUBLIC_PREFIX = 'public';

export const keys = {
  source: (videoId: string, ext: string) => `uploads/${videoId}/source${ext}`,
  hlsDir: (videoId: string) => `${PUBLIC_PREFIX}/hls/${videoId}`,
  hlsMaster: (videoId: string) => `${PUBLIC_PREFIX}/hls/${videoId}/master.m3u8`,
};

export function publicUrl(key: string): string {
  return `${config.S3_PUBLIC_ENDPOINT.replace(/\/$/, '')}/${config.S3_BUCKET}/${key}`;
}

// Oda kanalı odadaki herkese gider; transkod ilerlemesi ise yalnızca videoyu
// yükleyeni ilgilendiriyor.
export const userChannel = (userId: string) => `user:${userId}`;

export type UserEvent = {
  kind: 'VIDEO_PROGRESS';
  videoId: string;
  status: 'queued' | 'processing' | 'ready' | 'failed';
  percent: number | null;
  errorMessage?: string;
};
