import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';

import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectsCommand,
  ListObjectsV2Command,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

import { config, loadStorageConfig } from './config.ts';
import { createLogger } from './logger.ts';

const log = createLogger('storage');
const cfg = loadStorageConfig();

// Anahtar düzeni ve genel URL üretimi kimlik bilgisi gerektirmez; ayrı modülde.
export { keys, publicUrl, PUBLIC_PREFIX } from './media.ts';

const credentials = {
  accessKeyId: cfg.S3_ACCESS_KEY,
  secretAccessKey: cfg.S3_SECRET_KEY,
};

/** Sunucudan sunucuya işlemler (indir, yükle, listele). */
const internal = new S3Client({
  endpoint: cfg.S3_ENDPOINT,
  region: cfg.S3_REGION,
  credentials,
  // MinIO alt alan adı yönlendirmesini desteklemez; yol tabanlı erişim şart.
  forcePathStyle: true,
});

/**
 * SADECE presigned URL üretmek için. Farklı bir endpoint ile yapılandırılmıştır
 * çünkü imza host'u kapsar ve bu URL'ler tarayıcıya gider.
 */
const publicFacing = new S3Client({
  endpoint: config.S3_PUBLIC_ENDPOINT,
  region: cfg.S3_REGION,
  credentials,
  forcePathStyle: true,
});

export const BUCKET = config.S3_BUCKET;

/**
 * Tarayıcının dosyayı DOĞRUDAN storage'a yüklemesi için imzalı PUT adresi.
 *
 * Dosya API sunucusundan GEÇMEZ. Bir API sürecinin gigabaytlarca veriyi
 * proxy'lemesi belleği ve bağlantı havuzunu boşa harcar; bu yüzden API'nin
 * bodyLimit değeri yalnızca 1 MB.
 */
export async function presignUpload(
  key: string,
  contentType: string,
  expiresInSeconds = 900,
): Promise<string> {
  return getSignedUrl(
    publicFacing,
    new PutObjectCommand({ Bucket: BUCKET, Key: key, ContentType: contentType }),
    { expiresIn: expiresInSeconds },
  );
}

export async function headObject(key: string): Promise<{ size: number; contentType?: string } | null> {
  try {
    const res = await internal.send(new HeadObjectCommand({ Bucket: BUCKET, Key: key }));
    return { size: res.ContentLength ?? 0, contentType: res.ContentType };
  } catch {
    return null;
  }
}

/** Nesneyi yerel dosyaya indirir (worker transkod öncesi kullanır). */
export async function downloadToFile(key: string, destPath: string): Promise<void> {
  const res = await internal.send(new GetObjectCommand({ Bucket: BUCKET, Key: key }));
  if (!res.Body) throw new Error(`Nesne boş: ${key}`);
  await pipeline(res.Body as Readable, createWriteStream(destPath));
}

export async function putObject(
  key: string,
  body: Buffer | Uint8Array | string,
  contentType: string,
): Promise<void> {
  await internal.send(
    new PutObjectCommand({ Bucket: BUCKET, Key: key, Body: body, ContentType: contentType }),
  );
}

/** Bir önek altındaki tüm nesneleri siler (başarısız transkodun temizliği). */
export async function deletePrefix(prefix: string): Promise<number> {
  let deleted = 0;
  let token: string | undefined;

  do {
    const listed = await internal.send(
      new ListObjectsV2Command({ Bucket: BUCKET, Prefix: prefix, ContinuationToken: token }),
    );
    const objects = (listed.Contents ?? []).map((o) => ({ Key: o.Key! })).filter((o) => o.Key);

    if (objects.length > 0) {
      // DeleteObjects tek çağrıda en fazla 1000 anahtar kabul eder
      for (let i = 0; i < objects.length; i += 1000) {
        await internal.send(
          new DeleteObjectsCommand({
            Bucket: BUCKET,
            Delete: { Objects: objects.slice(i, i + 1000) },
          }),
        );
      }
      deleted += objects.length;
    }
    token = listed.IsTruncated ? listed.NextContinuationToken : undefined;
  } while (token);

  if (deleted > 0) log.info({ prefix, deleted }, 'Nesneler silindi');
  return deleted;
}

export async function pingStorage(): Promise<boolean> {
  try {
    await internal.send(new ListObjectsV2Command({ Bucket: BUCKET, MaxKeys: 1 }));
    return true;
  } catch (err) {
    log.error({ err }, 'Storage ping başarısız');
    return false;
  }
}
