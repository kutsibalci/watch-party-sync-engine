import { existsSync } from 'node:fs';
import { z } from 'zod';

// .env varsa yükle. Docker'da değişkenler compose'dan geldiği için dosya olmayabilir.
// Node 20.12+ yerleşik loadEnvFile — dotenv bağımlılığına gerek yok.
if (existsSync('.env') && typeof process.loadEnvFile === 'function') {
  process.loadEnvFile('.env');
}

/**
 * Yapılandırma BÖLÜMLERE ayrılmıştır — tek bir dev şema değil.
 *
 * Neden? Tek şema kullanınca her servis her değişkeni zorunlu kılar. Realtime
 * servisinin object storage ile hiçbir işi yoktur, ama tek şemayla S3_*
 * eksikse ayağa kalkamaz. Bu, servisleri gereksiz yere birbirine bağlar.
 *
 * Kural: bir servis yalnızca GERÇEKTEN kullandığı bölümü yükler.
 */

/** Her servisin ihtiyaç duyduğu temel ayarlar. */
const BaseSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace'])
    .default('info'),

  // 8080/8081 bu makinede WSL ve Docker tarafından IPv6 üzerinde tutuluyor;
  // varsayılanları çakışmayan portlara aldık.
  API_PORT: z.coerce.number().int().min(1).max(65535).default(8090),
  REALTIME_PORT: z.coerce.number().int().min(1).max(65535).default(8091),
  BROWSER_PORT: z.coerce.number().int().min(1).max(65535).default(8094),

  /** Bu sürecin kimliği. Faz 3'te loglarda ve presence kayıtlarında görünür. */
  INSTANCE_ID: z.string().min(1).default('local'),

  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url(),

  JWT_SECRET: z
    .string()
    .min(32, 'JWT_SECRET en az 32 karakter olmalı (openssl rand -base64 48)'),
  JWT_ISSUER: z.string().min(1).default('birlikte-izleme'),
  ACCESS_TOKEN_TTL: z.coerce.number().int().positive().default(900),
  REFRESH_TOKEN_TTL: z.coerce.number().int().positive().default(2_592_000),
  /**
   * Yeniden kullanım toleransı.
   *
   * Döndürülmüş bir jeton bu süre içinde ikinci kez sunulursa çalıntı SAYILMAZ:
   * neredeyse her zaman iki sekmenin ya da bir ağ tekrarının aynı jetonu
   * göndermesidir. İstemci Web Locks ile sıraya giriyor ama bu garanti değil —
   * garanti olmayan bir şeyin bedeli kullanıcının film ortasında çıkışa
   * atılması olamaz. Süre dolduktan sonra tespit yine katı: aile iptal edilir.
   */
  REFRESH_REUSE_LEEWAY_MS: z.coerce.number().int().min(0).default(5_000),

  CORS_ORIGIN: z.string().min(1).default('http://localhost:5173'),

  // --- Medya adresleme (GİZLİ DEĞİL) ---
  // Bunlar temel bölümde çünkü realtime servisi de HLS için genel URL üretmek
  // zorunda; ama S3 kimlik bilgilerine ihtiyacı yok ve almamalı da.
  /** TARAYICIDAN erişilen storage adresi. */
  S3_PUBLIC_ENDPOINT: z.string().url().default('http://127.0.0.1:9000'),
  S3_BUCKET: z.string().min(1).default('media'),
});

/** Yalnızca storage'a YAZAN/OKUYAN servisler için (api ve worker — realtime DEĞİL). */
const StorageSchema = z.object({
  /** Sunucudan sunucuya erişim. Docker içinde `http://minio:9000`. */
  S3_ENDPOINT: z.string().url(),
  S3_REGION: z.string().min(1).default('us-east-1'),
  S3_ACCESS_KEY: z.string().min(1),
  S3_SECRET_KEY: z.string().min(1),
});

/** Yalnızca ortak tarayıcı servisi için — diğer servislerin Chrome'a ihtiyacı yok. */
const BrowserSchema = z.object({
  /** Boşsa bilinen kurulum yollarında aranır. */
  CHROME_PATH: z.string().min(1).optional(),
  /** Son izleyici ayrıldıktan sonra sayfa bu süre boyunca açık kalır. */
  BROWSER_IDLE_MS: z.coerce.number().int().positive().default(120_000),
  /** Aynı anda açık tutulabilecek oda sayısı — her biri bir Chrome sekmesi. */
  BROWSER_MAX_SESSIONS: z.coerce.number().int().positive().default(4),

  /**
   * Sunucudaki sayfanın render boyutu VE tele giden kare boyutu — ikisi aynı.
   *
   * Önceden sayfa 1280x720 render edilip 960x540 gönderiliyordu; istemci bunu
   * geri büyütünce yazılar bulanıklaşıyordu ("pixel pixel"). Küçültmenin tek
   * kazancı bant genişliğiydi ve bunu artık kare atlayarak hallediyoruz.
   */
  BROWSER_WIDTH: z.coerce.number().int().min(640).max(2560).default(1280),
  BROWSER_HEIGHT: z.coerce.number().int().min(360).max(1440).default(720),
  /** JPEG kalitesi (0-100). 45 metni okunmaz hâle getiriyordu. */
  BROWSER_QUALITY: z.coerce.number().int().min(20).max(95).default(72),
  /** Saniyedeki en fazla kare — hem ağı hem sunucu CPU'sunu frenler. */
  BROWSER_MAX_FPS: z.coerce.number().int().min(5).max(60).default(30),

  /**
   * Bir izleyicinin soketinde biriken bayt bu tavanı geçerse o izleyiciye kare
   * GÖNDERİLMEZ.
   *
   * Kare hızını sabit bir sayıyla sınırlamak yanlış tarafı optimize ediyordu:
   * hızlı bağlantı gereksiz yere yavaşlıyor, yavaş bağlantı yine de tıkanıyordu.
   * Geri basınç ölçüsü doğrudan gecikmenin kendisi — biriken kuyruk.
   */
  BROWSER_MAX_BUFFERED_BYTES: z.coerce.number().int().positive().default(768 * 1024),
});

export type Config = z.infer<typeof BaseSchema>;
export type StorageConfig = z.infer<typeof StorageSchema>;
export type BrowserConfig = z.infer<typeof BrowserSchema>;

function parseSection<S extends z.ZodTypeAny>(schema: S, label: string): z.infer<S> {
  const parsed = schema.safeParse(process.env);
  if (parsed.success) return parsed.data;

  // Hızlı ve okunabilir başarısızlık: eksik yapılandırmayla ayağa kalkmak,
  // yarım çalışan bir servisten çok daha kötüdür.
  const issues = parsed.error.issues
    .map((i: z.ZodIssue) => `  - ${i.path.join('.') || '(kök)'}: ${i.message}`)
    .join('\n');
  process.stderr.write(
    `\n[config] Ortam değişkenleri geçersiz (${label} bölümü):\n${issues}\n\n` +
      `.env.example dosyasını .env olarak kopyaladığınızdan emin olun.\n\n`,
  );
  process.exit(1);
}

export const config: Config = parseSection(BaseSchema, 'temel');

/**
 * Storage ayarlarını yükler. Faz 2'de api (presigned URL üretimi) ve worker
 * (transkod çıktısı yükleme) açılışta bunu çağıracak — böylece eksik
 * yapılandırma ilk istekte değil, ayağa kalkarken fark edilir.
 */
export function loadStorageConfig(): StorageConfig {
  return parseSection(StorageSchema, 'storage');
}

export function loadBrowserConfig(): BrowserConfig {
  return parseSection(BrowserSchema, 'ortak tarayıcı');
}

export const isProduction = config.NODE_ENV === 'production';
export const isDevelopment = config.NODE_ENV === 'development';
