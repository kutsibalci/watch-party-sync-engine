/**
 * Protokolün SAF çekirdeği — tipler, sabitler ve yan etkisiz fonksiyonlar.
 *
 * Bu dosyanın HİÇBİR bağımlılığı yoktur ve olmamalıdır. Sebebi: esbuild ile
 * derlenip tarayıcıya `public/protocol.js` olarak servis ediliyor. zod'u buraya
 * koysaydık ~50 KB doğrulama kütüphanesi istemciye inerdi — istemcinin gelen
 * mesajı doğrulamaya ihtiyacı yok, sunucuya güveniyor.
 *
 * Çalışma anı doğrulama şemaları `protocol.ts` içinde; onları yalnızca sunucu
 * kullanır (istemci girdisi düşman girdisidir, sunucu doğrular).
 *
 * ┌─ NEDEN BU AYRIM VAR ────────────────────────────────────────────────────┐
 * │ Faz 1-3'te `public/app.js` bu sabitleri ve fonksiyonları ELLE           │
 * │ KOPYALIYORDU. İki kopyanın ayrışması an meselesiydi: drift eşiğini      │
 * │ sunucuda değiştirip istemcide unutmak sessiz bir hata üretirdi.         │
 * │ Artık tek kaynak var.                                                    │
 * └──────────────────────────────────────────────────────────────────────────┘
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

export type Member = {
  userId: string;
  displayName: string;
  isHost: boolean;
  joinedAtMs: number;
};

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
 * Üç kademeli drift düzeltme kararı.
 *
 * Doğrudan seek yapmak YANLIŞ cevaptır: her seek arabelleği boşaltır, videoyu
 * dondurur ve deneyimi bozar. %2'lik hız farkı kulakla duyulmaz ama 500ms'lik
 * bir sapmayı 25 saniyede sessizce kapatır.
 *
 * @param targetMs sunucuya göre olması gereken pozisyon
 * @param actualMs oynatıcının gerçek pozisyonu
 * @param canFineTuneRate oynatıcı 1.02 gibi ara hızları kabul ediyor mu?
 *        YouTube etmeyebilir — bu VARSAYILMAZ, çalışma anında ölçülür.
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
export type ClockSample = { offsetMs: number; rttMs: number };

/**
 * NTP'nin temel hesabı.
 *   RTT    = (t3 - t0) - (t2 - t1)      → ağda geçen toplam süre
 *   offset = ((t1 - t0) + (t2 - t3)) / 2 → sunucu saati - istemci saati
 */
export function computeClockSample(
  t0: number,
  t1: number,
  t2: number,
  t3: number,
): ClockSample {
  return {
    rttMs: t3 - t0 - (t2 - t1),
    offsetMs: (t1 - t0 + (t2 - t3)) / 2,
  };
}

/**
 * Örneklerden en iyisini seç: EN DÜŞÜK RTT'li olan.
 * Medyan da kullanılabilir ama en düşük RTT daha doğrudur — o pakette kuyruk
 * gecikmesi en azdır, dolayısıyla offset tahmini en az bulanıktır.
 */
export function bestSample(samples: readonly ClockSample[]): ClockSample | null {
  if (samples.length === 0) return null;
  return samples.reduce((best, s) => (s.rttMs < best.rttMs ? s : best));
}
