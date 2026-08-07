import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback) as (
  password: string | Buffer,
  salt: string | Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Parola özetleme — Node'un yerleşik scrypt'i ile, harici bağımlılık yok.
 *
 * Neden scrypt? bcrypt/argon2 native derleme gerektirir (Windows'ta sık sorun
 * çıkarır). scrypt Node çekirdeğinde vardır, bellek-zor (memory-hard) bir
 * fonksiyondur ve OWASP tarafından kabul edilir.
 *
 * Parametre seçimi — bilinçli bir ödünleşme:
 * scrypt'in bellek ihtiyacı ≈ 128 · N · r bayt.
 *   N=2^17 → ~134 MB/işlem. OWASP'ın önerdiği taban budur, ama 10 eşzamanlı
 *            giriş 1,3 GB RAM demektir; küçük bir sunucuyu tek başına düşürür.
 *   N=2^15 → ~33 MB/işlem. Hâlâ güçlü, eşzamanlılık altında ayakta kalır.
 * Bu proje 2^15 kullanır. Üretimde giriş uç noktasına hız sınırı (rate limit)
 * koyup N'i yükseltmek doğru yaklaşımdır — parametreler hash'in içinde
 * saklandığı için eski parolalar doğrulanmaya devam eder.
 */
const N = 1 << 15;
const R = 8;
const P = 1;
const KEY_LEN = 32;
const SALT_LEN = 16;
// scrypt'in bellek ihtiyacı ≈ 128 * N * r bayt. Tavanı biraz üstünde tutuyoruz.
const MAX_MEM = 256 * N * R;

/** Format: scrypt$N$r$p$<salt-b64>$<hash-b64> — parametreler saklanır ki
 *  ileride N'i artırdığınızda eski parolalar hâlâ doğrulanabilsin. */
export async function hashPassword(plain: string): Promise<string> {
  const salt = randomBytes(SALT_LEN);
  const derived = await scrypt(plain.normalize('NFKC'), salt, KEY_LEN, {
    N,
    r: R,
    p: P,
    maxmem: MAX_MEM,
  });
  return [
    'scrypt',
    N,
    R,
    P,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export async function verifyPassword(plain: string, stored: string): Promise<boolean> {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const n = Number.parseInt(parts[1] ?? '', 10);
  const r = Number.parseInt(parts[2] ?? '', 10);
  const p = Number.parseInt(parts[3] ?? '', 10);
  if (!Number.isFinite(n) || !Number.isFinite(r) || !Number.isFinite(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4] ?? '', 'base64');
    expected = Buffer.from(parts[5] ?? '', 'base64');
  } catch {
    return false;
  }
  if (salt.length === 0 || expected.length === 0) return false;

  const derived = await scrypt(plain.normalize('NFKC'), salt, expected.length, {
    N: n,
    r,
    p,
    maxmem: Math.max(MAX_MEM, 256 * n * r),
  });

  // Sabit zamanlı karşılaştırma: `===` kullanmak zamanlama saldırısına açık kapı bırakır.
  if (derived.length !== expected.length) return false;
  return timingSafeEqual(derived, expected);
}

/**
 * Kullanıcı bulunamadığında da parola doğrulamasıyla aynı süreyi harcamak için
 * kullanılır. Aksi hâlde yanıt süresi farkından "bu e-posta kayıtlı mı?"
 * bilgisi sızar (kullanıcı numaralandırma / user enumeration açığı).
 */
let dummyHashPromise: Promise<string> | null = null;

export async function fakeVerify(): Promise<void> {
  // Tembel üretim: modül yüklenirken scrypt çalıştırıp açılışı yavaşlatmıyoruz.
  dummyHashPromise ??= hashPassword('kullanici-numaralandirmasini-onleyen-sahte-parola');
  await verifyPassword('yanlis-parola', await dummyHashPromise);
}
