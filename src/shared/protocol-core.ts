/**
 * Protokolün saf çekirdeği: tipler, sabitler, yan etkisiz fonksiyonlar.
 *
 * Bağımlılığı yok ve olmamalı — esbuild ile derlenip tarayıcıya
 * public/protocol.js olarak servis ediliyor. zod buraya girseydi 50 KB'lık
 * doğrulama kütüphanesi istemciye inerdi; doğrulamayı zaten sunucu yapıyor
 * (şemalar protocol.ts'te).
 */

// ----------------------------------------------------------------- Kaynak
export type SourceRef =
  | { type: 'youtube'; videoId: string }
  | { type: 'hls'; url: string };

// ------------------------------------------------------------ Oynatma state
export type PlaybackState = {
  source: SourceRef | null;
  /** `updatedAtServerMs` anındaki pozisyon. Anlık pozisyon için effectivePositionMs(). */
  positionMs: number;
  isPlaying: boolean;
  playbackRate: number;
  /** Sunucu saati (Date.now()). İstemci buna kendi offset'ini uygular. */
  updatedAtServerMs: number;
  /** Monotonik. Her değişiklikte artar. Sırasızlığa karşı tek savunma. */
  version: number;
};

/** Bir katılımcının açık olan medya akışları. */
export type MediaFlags = { mic: boolean; cam: boolean; screen: boolean };

export type Member = {
  /** Eşler arası bağlantı bunun üzerinden adreslenir; kullanıcı iki sekme açabilir. */
  connectionId: string;
  userId: string;
  displayName: string;
  isHost: boolean;
  joinedAtMs: number;
  media: MediaFlags;
};

export const NO_MEDIA: MediaFlags = { mic: false, cam: false, screen: false };

/**
 * Mesh WebRTC'de kimin teklif göndereceği deterministik olmalı, yoksa iki
 * taraf da aynı anda teklif eder ve bağlantı kurulmaz. Kimlik sıralaması
 * her iki tarafta aynı sonucu verdiği için ek bir anlaşmaya gerek kalmıyor.
 */
export function shouldInitiateTo(selfId: string, peerId: string): boolean {
  return selfId < peerId;
}

/**
 * Mesh'te her katılımcı diğer herkese ayrı akış gönderir; yük katılımcı
 * sayısının karesiyle büyür. Bu sınırın üstünde SFU gerekir.
 */
export const MAX_MEDIA_PEERS = 6;

/**
 * Bir state'in verilen sunucu anındaki GERÇEK pozisyonu.
 * Oynuyorsa geçen süre kadar ilerlemiştir; duruyorsa sabittir.
 */
export function effectivePositionMs(state: PlaybackState, nowServerMs: number): number {
  if (!state.isPlaying) return state.positionMs;
  const elapsed = (nowServerMs - state.updatedAtServerMs) * state.playbackRate;
  return Math.max(0, state.positionMs + elapsed);
}

// ------------------------------------------------------- Drift düzeltmesi
/** Bu sapmanın altında hiçbir şey yapma — insan algılayamaz. */
export const DRIFT_IGNORE_MS = 100;
/** Bu sapmanın üstünde hard seek yap — hızla yakalamak imkânsız. */
export const DRIFT_SEEK_MS = 1_000;
/** Arada kalan sapmayı kapatmak için uygulanan hız farkı (%2 — kulakla duyulmaz). */
export const DRIFT_RATE_NUDGE = 0.02;
/** İnce hız ayarı yapılamayan oynatıcılarda (YouTube) kullanılan geniş bant. */
export const DRIFT_COARSE_SEEK_MS = 400;

export type DriftAction =
  | { action: 'none' }
  | { action: 'nudge'; playbackRate: number }
  | { action: 'seek'; toMs: number };

/**
 * Sapmayı kapatma kararı. Her sapmada seek etmek arabelleği boşaltıp videoyu
 * dondurur; %2'lik hız farkı ise duyulmaz ve 500 ms'yi 25 saniyede kapatır.
 *
 * `canFineTuneRate`: YouTube ara hızları kabul etmeyebilir, çağıran taraf bunu
 * çalışma anında ölçer.
 */
export function decideDriftAction(
  targetMs: number,
  actualMs: number,
  canFineTuneRate = true,
): DriftAction {
  const drift = targetMs - actualMs;
  const magnitude = Math.abs(drift);

  if (magnitude < DRIFT_IGNORE_MS) return { action: 'none' };
  if (magnitude >= DRIFT_SEEK_MS) return { action: 'seek', toMs: targetMs };

  if (!canFineTuneRate) {
    // İnce hız ayarı yoksa ikinci kademe uygulanamaz; daha geniş bir bant
    // tanıyıp ancak onu aşınca seek ediyoruz.
    return magnitude >= DRIFT_COARSE_SEEK_MS
      ? { action: 'seek', toMs: targetMs }
      : { action: 'none' };
  }

  // Geride kaldıysak hızlan, ileri gittiysek yavaşla
  const direction = drift > 0 ? 1 : -1;
  return { action: 'nudge', playbackRate: 1 + direction * DRIFT_RATE_NUDGE };
}

// ----------------------------------------------------------- Saat senkronu
export type ClockSample = { offsetMs: number; rttMs: number; atMs: number };

/**
 * Bir saat örneğinin geçerli sayıldığı süre.
 *
 * Sunucunun saati sabit varsayılamaz: sanal makineler askıya alınıp
 * uyandığında ya da NTP düzeltmesi geldiğinde saat sıçrar veya kayar. Bu
 * ortamda ölçtüğümüz Docker VM'i dakikada ~1 saniye kayıyordu.
 */
export const CLOCK_SAMPLE_MAX_AGE_MS = 120_000;

// NTP hesabı:
//   RTT    = (t3 - t0) - (t2 - t1)
//   offset = ((t1 - t0) + (t2 - t3)) / 2
export function computeClockSample(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): ClockSample {
  return {
    rttMs: t3 - t0 - (t2 - t1),
    offsetMs: (t1 - t0 + (t2 - t3)) / 2,
    atMs: t3,
  };
}

/** Kabul edilen RTT tavanı = en düşük RTT'nin bu katı. */
const RTT_TOLERANCE = 2;

/**
 * Saat farkı tahmini: düşük gecikmeli TAZE örneklerin MEDYANI.
 *
 * Önceki sürüm tek bir örneği seçiyordu: en düşük RTT'li olanı. Gerekçe
 * doğruydu (o pakette kuyruk gecikmesi en az, offset en az bulanık) ama
 * yalnızca AĞ GÜRÜLTÜSÜNE karşı koruyor. Ölçtüğümüz arıza başkaydı: sunucunun
 * saati saniyelerle sıçrıyordu. Sıçrama t1 ve t2'yi birlikte kaydırdığı için
 * RTT'ye hiç dokunmaz - örnek 1 ms RTT ile kusursuz görünür, offset'i 1,3
 * saniye yanlıştır. Tek örneğe bakan seçim bunu ayırt edemez.
 *
 * Ölçüm: RTT 1-4 ms bandındayken offset -1716 ile +861 arasında salındı.
 * Medyan bu tür aykırı değerlere dayanıklı; düşük RTT filtresi de jitter
 * korumasını koruyor.
 *
 * Tazelik şart: eskiden tüm geçmiş taranıyordu ve dakikalarca önce yakalanmış
 * şanslı bir örnek sonsuza kadar kazanabiliyordu.
 *
 * Not: saati sürekli sıçrayan bir sunucuyu hiçbir istemci düzeltemez; bu
 * altyapı arızasıdır. Buradaki iş tek tük aykırı örneğe teslim olmamak.
 */
export function bestSample(
  samples: readonly ClockSample[],
  nowMs: number,
): ClockSample | null {
  if (samples.length === 0) return null;

  const fresh = samples.filter((s) => nowMs - s.atMs <= CLOCK_SAMPLE_MAX_AGE_MS);
  const pool = fresh.length > 0 ? fresh : [samples[samples.length - 1]!];

  // Negatif RTT fiziksel olarak imkânsız: sunucu t1 ile t2 arasında takılmış
  // ya da saati sıçramış demektir. Böyle bir örnek "en düşük RTT" yarışını
  // kazanırdı; eliyoruz.
  const sane = pool.filter((s) => s.rttMs >= 0);
  const usable = sane.length > 0 ? sane : pool;

  const minRtt = Math.min(...usable.map((s) => s.rttMs));
  const lowJitter = usable.filter((s) => s.rttMs <= Math.max(minRtt * RTT_TOLERANCE, minRtt + 5));

  const offsets = lowJitter.map((s) => s.offsetMs).sort((a, b) => a - b);
  const mid = offsets.length >> 1;
  const offsetMs = offsets.length % 2 === 1
    ? offsets[mid]!
    : (offsets[mid - 1]! + offsets[mid]!) / 2;

  return { offsetMs, rttMs: minRtt, atMs: Math.max(...lowJitter.map((s) => s.atMs)) };
}
