// @ts-check
/**
 * Test istemcisi.
 *
 * Protokol sabitleri ve drift/saat matematiği ARTIK KOPYALANMIYOR:
 * `src/shared/protocol-core.ts` esbuild ile `public/protocol.js` olarak
 * derleniyor ve buradan içe aktarılıyor. Sunucu ve istemci tek kaynaktan
 * besleniyor — drift eşiğini bir tarafta değiştirip diğerinde unutmak artık
 * mümkün değil.
 */
import {
  effectivePositionMs,
  computeClockSample,
  bestSample,
  decideDriftAction,
} from '/app/protocol.js';

const API = location.origin;

/**
 * Hangi realtime instance'ına bağlanılacağı.
 *
 * Üretimde önde bir yük dengeleyici olur ve istemci bunu bilmez. Geliştirmede
 * iki instance ayrı portlarda çalışıyor; `?rt=8092` ile ikincisine bağlanmak,
 * paylaşılan state'in gerçekten çalıştığını TARAYICIDA göstermeyi sağlıyor:
 * iki sekme farklı süreçlere bağlıyken bile senkron kalmalı.
 */
const RT_PORT = new URLSearchParams(location.search).get('rt') || '8091';
const WS_BASE = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.hostname}:${RT_PORT}/ws`;

/**
 * hls.js kurucusu.
 *
 * esbuild IIFE + --global-name=Hls ile paketlendiğinde modül `window.Hls`
 * altına bir ad alanı nesnesi olarak düşer ve gerçek sınıf `.default`
 * içindedir. CDN'in UMD derlemesinde ise doğrudan `window.Hls`'tir.
 * İkisini de destekliyoruz ki paketleme yöntemi değişince sessizce bozulmasın.
 */
const HlsLib = globalThis.Hls?.isSupported ? globalThis.Hls : globalThis.Hls?.default;

// --------------------------------------------------------------- Durum
let token = localStorage.getItem('token') || '';
let me = null;
let slug = '';
let ws = null;
let state = null;
/** Gördüğümüz en yüksek versiyon. Bundan küçük/eşit STATE mesajları yoksayılır. */
let seenVersion = 0;

let clockOffsetMs = 0;
let clockRttMs = 0;
let clockSamples = [];

let reconnectAttempt = 0;
let ytPlayer = null;
let ytReady = false;
let hls = null;
/** Etkin oynatıcı adaptörü ('youtube' | 'hls' | null) */
let activeKind = null;

const $ = (id) => document.getElementById(id);

// ----------------------------------------------------------------- Yardımcı
async function api(method, path, body) {
  const res = await fetch(API + path, {
    method,
    headers: {
      ...(body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json?.error?.message || `HTTP ${res.status}`);
  return json;
}

function setStatus(id, text, kind = '') {
  const el = $(id);
  el.textContent = text;
  el.className = `status ${kind}`;
}

function enable(panelId) { $(panelId).classList.remove('disabled'); }

function fmt(ms) {
  if (!Number.isFinite(ms)) return '—';
  const s = Math.max(0, ms / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}.${String(Math.floor(ms % 1000)).padStart(3, '0')}`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ============================================================ OYNATICI ADAPTÖRÜ
//
// Drift düzeltmesi oynatıcıdan BAĞIMSIZ olmalı. İki oynatıcının yetenekleri
// farklı: HTML5 <video> istediğiniz playbackRate'i kabul eder, YouTube ise
// getAvailablePlaybackRates() listesine yuvarlayabilir. Bunu VARSAYMIYORUZ —
// `probeFineRate()` ile ÇALIŞMA ANINDA ölçüyoruz.

/** @type {null | {kind:string, ready:()=>boolean, positionMs:()=>number, seek:(ms:number)=>void,
 *   play:()=>void, pause:()=>void, isPlaying:()=>boolean, isBuffering:()=>boolean,
 *   setRate:(r:number)=>void, getRate:()=>number}} */
let player = null;
let supportsFineRate = null;
let nudgeActive = false;

const youtubeAdapter = {
  kind: 'youtube',
  ready: () => ytReady,
  positionMs: () => (ytPlayer?.getCurrentTime?.() ?? 0) * 1000,
  seek: (ms) => ytPlayer.seekTo(ms / 1000, true),
  play: () => ytPlayer.playVideo(),
  pause: () => ytPlayer.pauseVideo(),
  isPlaying: () => ytPlayer?.getPlayerState?.() === 1,
  isBuffering: () => ytPlayer?.getPlayerState?.() === 3,
  setRate: (r) => ytPlayer.setPlaybackRate(r),
  getRate: () => ytPlayer?.getPlaybackRate?.() ?? 1,
};

const hlsAdapter = {
  kind: 'hls',
  ready: () => $('video').readyState >= 1,
  positionMs: () => $('video').currentTime * 1000,
  seek: (ms) => { $('video').currentTime = ms / 1000; },
  play: () => { $('video').play().catch(() => {}); },
  pause: () => $('video').pause(),
  isPlaying: () => !$('video').paused && !$('video').ended,
  isBuffering: () => $('video').readyState < 3,
  setRate: (r) => { $('video').playbackRate = r; },
  getRate: () => $('video').playbackRate,
};

/** Kaynağı yükler ve etkin adaptörü değiştirir. */
function mountSource(source, startAtMs, shouldPlay) {
  if (!source) return;

  if (source.type === 'youtube') {
    if (activeKind !== 'youtube') {
      if (hls) { hls.destroy(); hls = null; }
      $('video').hidden = true;
      $('video').removeAttribute('src');
      $('player').hidden = false;
      activeKind = 'youtube';
      player = youtubeAdapter;
      supportsFineRate = null; // yetenek yeniden ölçülmeli
    }
    if (!ytReady) return;
    const current = ytPlayer.getVideoData?.()?.video_id;
    if (current !== source.videoId) {
      ytPlayer.loadVideoById(source.videoId, startAtMs / 1000);
      if (!shouldPlay) ytPlayer.pauseVideo();
    }
    $('source-label').textContent = `youtube:${source.videoId}`;
    return;
  }

  // --- HLS ---
  const video = $('video');
  if (activeKind !== 'hls' || video.dataset.src !== source.url) {
    $('player').hidden = true;
    video.hidden = false;
    activeKind = 'hls';
    player = hlsAdapter;
    supportsFineRate = null;

    if (hls) { hls.destroy(); hls = null; }

    if (HlsLib?.isSupported()) {
      hls = new HlsLib({ enableWorker: true, lowLatencyMode: false });
      hls.loadSource(source.url);
      hls.attachMedia(video);
      hls.on(HlsLib.Events.ERROR, (_e, data) => {
        if (data.fatal) addChat('sys', `HLS hatası: ${data.type} / ${data.details}`);
      });
    } else {
      // Safari HLS'i yerel olarak destekler, hls.js gerekmez
      video.src = source.url;
    }
    video.dataset.src = source.url;
    video.currentTime = startAtMs / 1000;
  }
  $('source-label').textContent = 'hls';
}

// -------------------------------------------------------------------- Auth
$('btn-random').onclick = () => {
  const n = Math.floor(Math.random() * 100000);
  $('email').value = `kullanici${n}@example.com`;
  $('password').value = 'CokGizliParola123';
  $('display-name').value = `Kullanıcı ${n}`;
};

function afterAuth(result) {
  token = result.accessToken;
  me = result.user;
  localStorage.setItem('token', token);
  setStatus('auth-status', `Giriş yapıldı: ${me.displayName}`, 'ok');
  enable('room-panel');
  enable('upload-panel');
  void refreshVideos();
}

$('btn-register').onclick = async () => {
  try {
    afterAuth(await api('POST', '/api/auth/register', {
      email: $('email').value,
      password: $('password').value,
      displayName: $('display-name').value || 'Anonim',
    }));
  } catch (e) { setStatus('auth-status', e.message, 'err'); }
};

$('btn-login').onclick = async () => {
  try {
    afterAuth(await api('POST', '/api/auth/login', {
      email: $('email').value,
      password: $('password').value,
    }));
  } catch (e) { setStatus('auth-status', e.message, 'err'); }
};

// -------------------------------------------------------------------- Oda
$('btn-create').onclick = async () => {
  try {
    const { room } = await api('POST', '/api/rooms', {
      name: $('room-name').value,
      youtubeVideoId: $('yt-id').value || undefined,
    });
    $('room-slug').value = room.slug;
    setStatus('room-status', `Oda oluşturuldu: ${room.slug}`, 'ok');
    connect(room.slug);
  } catch (e) { setStatus('room-status', e.message, 'err'); }
};

$('btn-join').onclick = async () => {
  const s = $('room-slug').value.trim();
  if (!s) return setStatus('room-status', 'Oda kodu girin', 'err');
  try {
    await api('POST', `/api/rooms/${s}/join`);
    connect(s);
  } catch (e) { setStatus('room-status', e.message, 'err'); }
};

// =============================================================== FAZ 2: YÜKLEME
$('btn-upload').onclick = async () => {
  const file = $('file-input').files?.[0];
  if (!file) return setStatus('upload-status', 'Önce bir dosya seçin', 'err');

  try {
    // 1) Yükleme adresi iste — sunucu videos satırını oluşturur ve imzalı PUT verir
    setStatus('upload-status', 'Yükleme adresi alınıyor…');
    const { video, upload } = await api('POST', '/api/videos', {
      title: file.name,
      filename: file.name,
      contentType: file.type || 'application/octet-stream',
      sizeBytes: file.size,
    });

    // 2) Dosyayı DOĞRUDAN storage'a gönder — API sunucusundan geçmez.
    //    fetch() yükleme ilerlemesi vermediği için XHR kullanıyoruz.
    setStatus('upload-status', 'Yükleniyor…');
    await putWithProgress(upload.url, file, upload.headers, (pct) => setProgress(pct, 'yükleme'));

    // 3) Sunucuya bildir — dosyanın gerçekten geldiğini doğrulayıp kuyruğa atar
    setStatus('upload-status', 'İşleme kuyruğuna alınıyor…');
    await api('POST', `/api/videos/${video.id}/complete`);

    // 4) Hazır olana kadar bekle (WS push varsa ondan, yoksa yoklama)
    const { video: ready, via } = await waitUntilReady(video.id);
    setProgress(100, 'tamamlandı');
    setStatus(
      'upload-status',
      `Hazır: ${ready.title} (${Math.round(ready.durationMs / 1000)} sn) · ${via}`,
      'ok',
    );
    await refreshVideos();
  } catch (e) {
    setStatus('upload-status', e.message, 'err');
    setProgress(0, 'hata');
  }
};

function putWithProgress(url, file, headers, onProgress) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', url);
    for (const [k, v] of Object.entries(headers || {})) xhr.setRequestHeader(k, v);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () =>
      xhr.status >= 200 && xhr.status < 300
        ? resolve(null)
        : reject(new Error(`Yükleme başarısız: HTTP ${xhr.status}`));
    xhr.onerror = () => reject(new Error('Yükleme sırasında ağ hatası'));
    xhr.send(file);
  });
}

/**
 * Videonun hazır olmasını bekler.
 *
 * Öncelik WebSocket'ten İTİLEN olaylarda; ama WS bağlı değilse (kullanıcı
 * henüz odaya girmediyse) yoklamaya düşüyoruz. İki yol da aynı sonuca varır —
 * push hızlı, polling dayanıklı.
 */
async function waitUntilReady(videoId, timeoutMs = 15 * 60_000) {
  const deadline = Date.now() + timeoutMs;

  const pushed = new Promise((resolve, reject) => {
    progressWatchers.set(videoId, (e) => {
      if (e.status === 'ready') resolve('push');
      if (e.status === 'failed') reject(new Error(`Transkod başarısız: ${e.errorMessage ?? ''}`));
    });
  });

  const polled = (async () => {
    while (Date.now() < deadline) {
      const { video } = await api('GET', `/api/videos/${videoId}`);
      if (video.status === 'ready') return 'polling';
      if (video.status === 'failed') throw new Error(`Transkod başarısız: ${video.errorMessage}`);
      // WS bağlıysa ilerlemeyi o yazıyor; burada üzerine yazmıyoruz.
      if (ws?.readyState !== WebSocket.OPEN) {
        setProgress(video.progress ?? 0, `transkod (${video.status})`);
      }
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error('Transkod zaman aşımına uğradı');
  })();

  try {
    const via = await Promise.race([pushed, polled]);
    const { video } = await api('GET', `/api/videos/${videoId}`);
    return { video, via };
  } finally {
    progressWatchers.delete(videoId);
  }
}

function setProgress(pct, label) {
  $('progress-fill').style.width = `${Math.max(0, Math.min(100, pct))}%`;
  $('progress-label').textContent = `${label} · %${pct}`;
}

async function refreshVideos() {
  try {
    const { videos } = await api('GET', '/api/videos');
    $('video-list').innerHTML = videos.length === 0
      ? '<li class="muted">henüz video yok</li>'
      : videos.map((v) => `
          <li>
            <span class="v-title">${escapeHtml(v.title)}</span>
            <span class="v-status v-${v.status}">${v.status}</span>
            ${v.status === 'ready'
              ? `<button class="ghost small" data-play="${v.id}">odada oynat</button>`
              : ''}
          </li>`).join('');

    for (const btn of $('video-list').querySelectorAll('[data-play]')) {
      btn.onclick = () => useVideoInRoom(btn.getAttribute('data-play'));
    }
  } catch { /* giriş yapılmamış olabilir */ }
}

/** Odanın kaynağını bu videoya çevirir ve canlı olarak herkese bildirir. */
async function useVideoInRoom(videoId) {
  if (!slug) return setStatus('upload-status', 'Önce bir odaya bağlanın', 'err');
  try {
    await api('PATCH', `/api/rooms/${slug}/video`, { videoId });
    const { video } = await api('GET', `/api/videos/${videoId}`);
    // Kalıcı kayıt güncellendi; şimdi odadakilere canlı bildir (yalnızca host yapabilir)
    sendMsg({ type: 'SET_SOURCE', source: { type: 'hls', url: video.hlsUrl } });
    setStatus('upload-status', `Oda kaynağı değişti: ${video.title}`, 'ok');
  } catch (e) { setStatus('upload-status', e.message, 'err'); }
}

// --------------------------------------------------------------- WebSocket
async function connect(roomSlug) {
  slug = roomSlug;
  seenVersion = 0;
  clockSamples = [];

  if (ws) { ws.onclose = null; ws.close(); }

  // Ham JWT'yi query string'e KOYMUYORUZ. Önce API'den 30 saniyelik,
  // tek kullanımlık, tek odaya kilitli bir bilet alıyoruz. Query string
  // loglara düşse bile bilet saniyeler içinde değersizleşir.
  let ticket;
  try {
    ({ ticket } = await api('POST', `/api/rooms/${slug}/ticket`));
  } catch (e) {
    setStatus('room-status', `Bilet alınamadı: ${e.message}`, 'err');
    return;
  }

  ws = new WebSocket(`${WS_BASE}?room=${encodeURIComponent(slug)}&ticket=${encodeURIComponent(ticket)}`);

  ws.onopen = () => {
    reconnectAttempt = 0;
    // Hangi realtime instance'ına bağlı olduğumuzu göster — iki sekme farklı
    // portlarda açıldığında paylaşılan state'in kanıtı gözle görülür olsun.
    $('conn-state').textContent = `bağlı · realtime :${RT_PORT}`;
    $('conn-state').className = 'pill pill-on';
    enable('watch-panel');
    $('invite-link').value = `${location.origin}/app/?room=${slug}`;
    // İkinci realtime instance'ına bağlanan davet linki. Bu linkle açılan
    // sekme FARKLI bir sürece bağlanır ama aynı odada senkron kalır —
    // paylaşılan state'in en hızlı gözle görülür kanıtı.
    $('invite-link-2').value = `${location.origin}/app/?room=${slug}&rt=8092`;
    syncClock(10);
  };

  ws.onmessage = (ev) => handleMessage(JSON.parse(ev.data));

  ws.onclose = (ev) => {
    $('conn-state').textContent = 'bağlantı kesildi';
    $('conn-state').className = 'pill pill-off';
    // 1012 = Service Restart: sunucu bilinçli kapanıyor, hemen yeniden bağlan.
    // Diğer durumlarda üstel geri çekilme — sunucu çöktüyse fırtına yaratmayalım.
    const delay = ev.code === 1012 ? 500 : Math.min(1000 * 2 ** reconnectAttempt++, 15000);
    addChat('sys', `bağlantı koptu (${ev.code}) — ${Math.round(delay / 1000)}s sonra yeniden denenecek`);
    setTimeout(() => connect(slug), delay);
  };
}

function sendMsg(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'HELLO':
      me = msg.you;
      applyState(msg.state);
      renderMembers(msg.members);
      addChat('sys', `"${msg.room.name}" odasına bağlanıldı`);
      break;

    case 'PONG': {
      clockSamples.push(computeClockSample(msg.t0, msg.t1, msg.t2, Date.now()));
      // En düşük RTT'li örnek en doğrusudur: o pakette kuyruk gecikmesi en azdır.
      const best = bestSample(clockSamples);
      clockOffsetMs = best.offsetMs;
      clockRttMs = best.rttMs;
      $('t-offset').textContent = `${clockOffsetMs.toFixed(1)} ms`;
      $('t-rtt').textContent = `${clockRttMs.toFixed(1)} ms`;
      break;
    }

    case 'STATE':   applyState(msg.state); break;
    case 'PRESENCE': renderMembers(msg.members); break;
    case 'CHAT':    addChat('msg', msg.text, msg.displayName); break;
    case 'ERROR':   addChat('sys', `hata: ${msg.message}`); break;

    // Faz 4: transkod ilerlemesi artık YOKLANMIYOR, sunucudan itiliyor.
    case 'VIDEO_PROGRESS':
      onVideoProgress(msg);
      break;
  }
}

/** @type {Map<string, (e:any)=>void>} videoId → ilerlemeyi bekleyen çözücü */
const progressWatchers = new Map();

function onVideoProgress(msg) {
  const label = msg.status === 'processing' ? 'transkod' : msg.status;
  setProgress(msg.percent ?? 0, label);
  const watcher = progressWatchers.get(msg.videoId);
  if (watcher) watcher(msg);
}

/**
 * Sunucudan gelen state'i uygula — ama SIRASIZ/ESKİ mesajları reddet.
 * Bu tek kontrol hem ağ sırasızlığını hem de "iki kişi aynı anda pause'a
 * bastı" yarışını çözer.
 */
function applyState(next) {
  if (next.version <= seenVersion) return;
  seenVersion = next.version;
  state = next;
  $('t-version').textContent = String(next.version);
  mountSource(next.source, next.positionMs, next.isPlaying);
}

// --------------------------------------------------------------- Saat senkronu
function syncClock(count) {
  for (let i = 0; i < count; i++) {
    setTimeout(() => sendMsg({ type: 'PING', t0: Date.now() }), i * 120);
  }
}
// Saatler sürüklenir (özellikle uyku/uyanma sonrası) — düzenli yeniden ölç.
setInterval(() => {
  if (ws?.readyState === WebSocket.OPEN) {
    if (clockSamples.length > 40) clockSamples = clockSamples.slice(-10);
    syncClock(3);
  }
}, 30000);

// ------------------------------------------------------------- YouTube hazır
window.onYouTubeIframeAPIReady = () => {
  ytPlayer = new YT.Player('player', {
    height: '100%',
    width: '100%',
    playerVars: { controls: 1, disablekb: 1, rel: 0, modestbranding: 1 },
    events: {
      onReady: () => {
        ytReady = true;
        if (state) { seenVersion -= 1; applyState(state); }
      },
    },
  });
};

// -------------------------------------------------------- Kontrol butonları
//
// Komutlar YALNIZCA butonlardan gönderilir; oynatıcının kendi olaylarını
// dinleyip komuta çevirmiyoruz. Aksi hâlde "sunucudan gelen state'i uygula →
// oynatıcı olay üretir → komut gönder → sunucu yayınlar" sonsuz döngüsü olur.
$('btn-play').onclick  = () => sendMsg({ type: 'PLAY', positionMs: currentPositionMs() });
$('btn-pause').onclick = () => sendMsg({ type: 'PAUSE', positionMs: currentPositionMs() });
$('btn-back').onclick  = () => sendMsg({ type: 'SEEK', positionMs: Math.max(0, currentPositionMs() - 10000) });
$('btn-fwd').onclick   = () => sendMsg({ type: 'SEEK', positionMs: currentPositionMs() + 10000 });

$('btn-chat').onclick = sendChat;
$('chat-input').onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };

function sendChat() {
  const text = $('chat-input').value.trim();
  if (!text) return;
  sendMsg({ type: 'CHAT', text });
  $('chat-input').value = '';
}

function currentPositionMs() {
  return player?.ready() ? player.positionMs() : 0;
}

// ------------------------------------------------------ Drift düzeltme döngüsü
setInterval(controlTick, 250);

function controlTick() {
  if (!state || !state.source || !player || !player.ready()) return;

  const nowServer = Date.now() + clockOffsetMs;
  const target = effectivePositionMs(state, nowServer);
  const actual = player.positionMs();

  $('t-player').textContent = `${player.kind}${supportsFineRate === false ? ' (ince hız yok)' : ''}`;

  // 1) Oynat/duraklat durumunu state ile hizala
  if (state.isPlaying && !player.isPlaying() && !player.isBuffering()) player.play();
  if (!state.isPlaying && player.isPlaying()) player.pause();

  $('t-target').textContent = fmt(target);
  $('t-actual').textContent = fmt(actual);

  // Arabellek doldururken pozisyon güvenilmez — ölçüm yapma.
  if (player.isBuffering()) { setAction('arabellek — ölçüm atlandı', ''); return; }

  const drift = target - actual;
  $('t-drift').textContent = `${drift >= 0 ? '+' : ''}${drift.toFixed(0)} ms`;

  sendMsg({ type: 'HEARTBEAT', positionMs: Math.max(0, actual), driftMs: drift });

  applyDriftCorrection(target, actual);
}

/**
 * Üç kademeli düzeltme. KARAR paylaşılan `decideDriftAction()` fonksiyonunda —
 * sunucu ile aynı eşikler. Burada yalnızca kararı UYGULUYORUZ.
 *
 * Oynatıcının ince hız ayarını desteklediğini VARSAYMIYORUZ: ilk denemede
 * hızı ayarlayıp geri okuyarak ÖLÇÜYORUZ. HTML5 <video> destekler, YouTube
 * getAvailablePlaybackRates() listesine yuvarlayabilir.
 */
function applyDriftCorrection(target, actual) {
  // Yetenek henüz ölçülmediyse iyimser başla; ilk nudge denemesinde ölçülecek.
  const decision = decideDriftAction(target, actual, supportsFineRate !== false);

  if (decision.action === 'none') {
    if (nudgeActive) { player.setRate(1); nudgeActive = false; }
    setAction(
      supportsFineRate === false ? 'yok (ince hız yok, bant içinde)' : 'yok (sapma algılanamaz)',
      'drift-ok',
    );
    return;
  }

  if (decision.action === 'seek') {
    if (nudgeActive) { player.setRate(1); nudgeActive = false; }
    player.seek(decision.toMs);
    setAction(`sert atlama → ${fmt(decision.toMs)}`, 'drift-seek');
    return;
  }

  // nudge — önce yeteneği ölç (bir kez)
  const desired = decision.playbackRate;
  if (supportsFineRate === null) {
    player.setRate(desired);
    supportsFineRate = Math.abs(player.getRate() - desired) < 0.005;
    if (!supportsFineRate) {
      player.setRate(1);
      // Yetenek yokmuş: kararı yeniden ver, bu sefer doğru bilgiyle.
      applyDriftCorrection(target, actual);
      return;
    }
  }

  player.setRate(desired);
  nudgeActive = true;
  setAction(`hız ${desired.toFixed(2)}× ile yakalanıyor`, 'drift-nudge');
}

function setAction(text, cls) {
  const el = $('t-action');
  el.textContent = text;
  el.className = cls;
}

// ------------------------------------------------------------------ Arayüz
function renderMembers(members) {
  $('members').innerHTML = members
    .map((m) => `<li><span>${escapeHtml(m.displayName)}</span>${m.isHost ? '<span class="host-tag">HOST</span>' : ''}</li>`)
    .join('');
}

function addChat(kind, text, who) {
  const log = $('chat-log');
  const div = document.createElement('div');
  if (kind === 'sys') {
    div.className = 'sys';
    div.textContent = text;
  } else {
    div.innerHTML = `<span class="who">${escapeHtml(who)}:</span> ${escapeHtml(text)}`;
  }
  log.appendChild(div);
  log.scrollTop = log.scrollHeight;
}

// Davet linkiyle gelindiyse oda kodunu doldur
const urlRoom = new URLSearchParams(location.search).get('room');
if (urlRoom) $('room-slug').value = urlRoom;
if (token) {
  api('GET', '/api/auth/me')
    .then(({ user }) => {
      me = user;
      setStatus('auth-status', `Oturum sürüyor: ${user.displayName}`, 'ok');
      enable('room-panel');
      enable('upload-panel');
      void refreshVideos();
    })
    .catch(() => { token = ''; localStorage.removeItem('token'); });
}
