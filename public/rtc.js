// @ts-check
/**
 * Mesh WebRTC: sesli/görüntülü sohbet ve ekran paylaşımı.
 *
 * Her katılımcı diğer herkese ayrı bağlantı kurar; yük katılımcı sayısının
 * karesiyle büyüdüğü için MAX_MEDIA_PEERS'ta duruyoruz, ötesi SFU işi.
 *
 * TURN sunucumuz yok, yalnızca genel STUN. Simetrik NAT arkasındaki
 * kullanıcılar (kurumsal ağlar, bazı mobil operatörler) bağlanamayabilir;
 * gerçek dağıtımda coturn şart.
 */
import { shouldInitiateTo, MAX_MEDIA_PEERS } from '/app/protocol.js';

const ICE = {
  iceServers: [{ urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] }],
};

export function createMesh({ send, onRemote, onDrop, onError }) {
  /** @type {Map<string, {pc: RTCPeerConnection, polite: boolean, makingOffer: boolean, ignoreOffer: boolean, senders: RTCRtpSender[]}>} */
  const peers = new Map();
  let selfId = '';
  let localStream = null;

  function setSelf(id) { selfId = id; }

  /**
   * "Perfect negotiation" deseni.
   *
   * İlk sürümde yalnızca kimliği küçük olan taraf teklif ediyordu. Medyayı
   * açan taraf büyük kimlikliyse teklif edemiyor, karşı taraf da gönderecek
   * akışı olmadığı için boş teklif üretiyordu: bağlantı kuruluyor ama hiçbir
   * akış geçmiyordu. Testte tam olarak bu çıktı.
   *
   * Artık akışı olan her taraf teklif edebiliyor. İki taraf aynı anda teklif
   * ederse (glare) "kibar" olan kendi teklifini geri alıp karşınınkini kabul
   * ediyor; kibarlığı kimlik sıralaması belirlediği için iki uç da aynı
   * sonuca varıyor.
   */
  function peerFor(peerId, peerName) {
    const existing = peers.get(peerId);
    if (existing) return existing;

    const pc = new RTCPeerConnection(ICE);
    const entry = { pc, polite: !shouldInitiateTo(selfId, peerId), makingOffer: false, ignoreOffer: false, senders: [] };
    peers.set(peerId, entry);

    pc.onicecandidate = (e) => {
      if (e.candidate) send(peerId, { kind: 'ice', candidate: e.candidate.toJSON() });
    };

    pc.ontrack = (e) => onRemote(peerId, peerName, e.streams[0]);

    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') drop(peerId);
    };

    pc.onnegotiationneeded = async () => {
      try {
        entry.makingOffer = true;
        await pc.setLocalDescription();
        send(peerId, { kind: 'sdp', sdp: pc.localDescription });
      } catch (e) {
        onError?.(`teklif oluşturulamadı: ${e.message}`);
      } finally {
        entry.makingOffer = false;
      }
    };

    attachLocalTracks(entry);
    return entry;
  }

  function attachLocalTracks(entry) {
    if (!localStream) return;
    entry.senders = localStream.getTracks().map((t) => entry.pc.addTrack(t, localStream));
  }

  async function handleSignal(fromId, fromName, data) {
    const entry = peerFor(fromId, fromName);
    const { pc } = entry;

    try {
      if (data.kind === 'ice') {
        try { await pc.addIceCandidate(data.candidate); }
        catch (e) { if (!entry.ignoreOffer) throw e; }
        return;
      }
      if (data.kind !== 'sdp') return;

      const offerCollision = data.sdp.type === 'offer'
        && (entry.makingOffer || pc.signalingState !== 'stable');

      entry.ignoreOffer = !entry.polite && offerCollision;
      if (entry.ignoreOffer) return;

      // Kibar taraf çakışmada kendi teklifini geri alır.
      if (offerCollision) await pc.setLocalDescription({ type: 'rollback' });

      await pc.setRemoteDescription(data.sdp);

      if (data.sdp.type === 'offer') {
        await pc.setLocalDescription();
        send(fromId, { kind: 'sdp', sdp: pc.localDescription });
      }
    } catch (e) {
      onError?.(`sinyal işlenemedi: ${e.message}`);
    }
  }

  /** Odadaki eş listesine göre bağlantı kurar/kapatır. */
  function sync(peerList) {
    const wanted = peerList.slice(0, MAX_MEDIA_PEERS - 1);
    const ids = new Set(wanted.map((p) => p.connectionId));

    for (const id of [...peers.keys()]) if (!ids.has(id)) drop(id);

    for (const p of wanted) {
      const theyShare = p.media?.mic || p.media?.cam || p.media?.screen;
      if (!theyShare && !localStream) continue;
      // Yalnızca bağlantıyı kur. Teklif gerekiyorsa onnegotiationneeded
      // kendiliğinden tetiklenir; burada elle teklif etmek glare üretir.
      peerFor(p.connectionId, p.displayName);
    }
  }

  function drop(peerId) {
    const entry = peers.get(peerId);
    if (!entry) return;
    const { pc } = entry;
    pc.onicecandidate = null; pc.ontrack = null;
    pc.onnegotiationneeded = null; pc.onconnectionstatechange = null;
    pc.close();
    peers.delete(peerId);
    onDrop?.(peerId);
  }

  /** Yerel akışı değiştirir; her eşte yeniden pazarlık kendiliğinden tetiklenir. */
  async function setLocalStream(stream) {
    const old = localStream;
    localStream = stream;

    for (const entry of peers.values()) {
      for (const s of entry.senders) {
        try { entry.pc.removeTrack(s); } catch { /* bağlantı kapanmış olabilir */ }
      }
      entry.senders = [];
      attachLocalTracks(entry);
    }

    if (old && old !== stream) for (const t of old.getTracks()) t.stop();
  }

  function closeAll() {
    for (const id of [...peers.keys()]) drop(id);
    if (localStream) for (const t of localStream.getTracks()) t.stop();
    localStream = null;
  }

  return { setSelf, handleSignal, sync, setLocalStream, closeAll, get stream() { return localStream; } };
}
