/**
 * youtube-radio.js
 * ------------------------------------------------------------------
 * Player YouTube nascosto (solo audio) + sync tra tutti gli utenti.
 *
 * Come funziona:
 * 1. Carica l'IFrame Player API ufficiale di YouTube.
 * 2. Crea un player YouTube reale ma visivamente nascosto (1x1px, fuori
 *    schermo). Il video "esiste" ma nessuno lo vede: si sente solo l'audio.
 * 3. Quando arriva una nuova traccia YouTube (dal tuo backend /download,
 *    caso "source: youtube"), calcola quanti secondi sono già passati da
 *    "startedAt" e fa partire il video esattamente da lì, così chi si
 *    collega dopo sente comunque la canzone in sync con gli altri.
 *
 * COSA DEVI ADATTARE (cerca i commenti "TODO"):
 * - Il punto in cui ricevi una nuova traccia dalla coda (Supabase realtime,
 *   polling, websocket... qualsiasi cosa usi già in index.html).
 * - Il punto in cui oggi fai `audioElement.src = data.audioUrl` per i file
 *   mp3: qui basta un `if` per instradare su YouTube o su file normale.
 *
 * Non serve nessuna API key: l'IFrame Player è pubblico e gratuito.
 * ------------------------------------------------------------------
 */

(function () {
  let ytPlayer = null;
  let ytApiReady = false;
  let pendingTrack = null; // se arriva una traccia prima che l'API sia pronta

  // --- 1. Carica l'IFrame API di YouTube (una sola volta) ---
  function loadYouTubeIframeApi() {
    if (window.YT && window.YT.Player) {
      ytApiReady = true;
      createHiddenPlayer();
      return;
    }
    const tag = document.createElement("script");
    tag.src = "https://www.youtube.com/iframe_api";
    document.head.appendChild(tag);

    // YouTube chiama questa funzione globale quando l'API è pronta
    window.onYouTubeIframeAPIReady = function () {
      ytApiReady = true;
      createHiddenPlayer();
    };
  }

  // --- 2. Crea il player nascosto ---
  function createHiddenPlayer() {
    const mount = document.createElement("div");
    mount.id = "yt-hidden-player-mount";
    // Nascosto ma non display:none (alcuni browser mettono in pausa i
    // media con display:none): lo spostiamo fuori dallo schermo.
    mount.style.position = "fixed";
    mount.style.left = "-9999px";
    mount.style.top = "-9999px";
    mount.style.width = "1px";
    mount.style.height = "1px";
    mount.style.pointerEvents = "none";
    document.body.appendChild(mount);

    ytPlayer = new YT.Player(mount.id, {
      height: "1",
      width: "1",
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
      },
      events: {
        onReady: function () {
          if (pendingTrack) {
            playYouTubeTrack(pendingTrack.youtubeId, pendingTrack.startedAt);
            pendingTrack = null;
          }
        },
      },
    });
  }

  /**
   * Fa partire (o riprende in sync) un video YouTube.
   * @param {string} youtubeId - ID del video (es. "dQw4w9WgXcQ")
   * @param {number} startedAtMs - timestamp epoch (ms) di quando la traccia
   *        è stata messa in coda dal server. Serve per calcolare l'offset.
   */
  function playYouTubeTrack(youtubeId, startedAtMs) {
    if (!ytApiReady || !ytPlayer || typeof ytPlayer.loadVideoById !== "function") {
      pendingTrack = { youtubeId, startedAt: startedAtMs };
      loadYouTubeIframeApi();
      return;
    }

    const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);

    ytPlayer.loadVideoById({
      videoId: youtubeId,
      startSeconds: elapsedSeconds,
    });

    // Alcuni browser bloccano l'autoplay con audio: se il player resta in
    // pausa, mostriamo un pulsante "Attiva audio" (vedi ensureAudioUnlocked).
    setTimeout(() => {
      try {
        ytPlayer.playVideo();
      } catch (e) {}
    }, 300);
  }

  function stopYouTubeTrack() {
    if (ytPlayer && typeof ytPlayer.stopVideo === "function") {
      ytPlayer.stopVideo();
    }
  }

  function setYouTubeVolume(percent /* 0-100 */) {
    if (ytPlayer && typeof ytPlayer.setVolume === "function") {
      ytPlayer.setVolume(percent);
    }
  }

  // Molti browser richiedono un'interazione utente prima di permettere
  // l'autoplay con audio. Chiama questa funzione dentro il click del tuo
  // pulsante "AVVIA STREAM RADIO" già presente in index.html.
  function unlockYouTubeAudio() {
    if (!ytApiReady) {
      loadYouTubeIframeApi();
      return;
    }
    if (ytPlayer && typeof ytPlayer.playVideo === "function") {
      try {
        ytPlayer.playVideo();
      } catch (e) {}
    }
  }

  // Espone le funzioni per usarle nel resto del tuo codice (index.html)
  window.ChinoFMYouTube = {
    init: loadYouTubeIframeApi,
    play: playYouTubeTrack,
    stop: stopYouTubeTrack,
    setVolume: setYouTubeVolume,
    unlock: unlockYouTubeAudio,
  };

  // Inizializza subito il caricamento dell'API (il player resta in pausa
  // finché non arriva una traccia o l'utente clicca "AVVIA STREAM RADIO").
  loadYouTubeIframeApi();
})();
