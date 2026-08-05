// name=public/youtube-radio.js
(function () {
  let ytPlayer = null;
  let ytApiReady = false;
  let playerReady = false;
  let pendingTrack = null;
  let unlocked = false; // true once the user has interacted at least once

  function log(...args) { console.log('[youtube-radio]', ...args); }
  function warn(...args) { console.warn('[youtube-radio]', ...args); }

  function emitState(state) {
    // Lets the page react (e.g. VU meter animation) without coupling the two files.
    window.dispatchEvent(new CustomEvent('chinofm:ytstate', { detail: { state } }));
  }

  function loadYouTubeIframeApi() {
    if (window.YT && window.YT.Player) {
      ytApiReady = true;
      log('YT API already available');
      createHiddenPlayer();
      return;
    }
    if (document.getElementById('yt-iframe-api-script')) return; // already injected
    const tag = document.createElement('script');
    tag.id = 'yt-iframe-api-script';
    tag.src = 'https://www.youtube.com/iframe_api';
    tag.onerror = () => warn('Errore caricamento IFrame API YouTube');
    document.head.appendChild(tag);
    window.onYouTubeIframeAPIReady = function () {
      ytApiReady = true;
      log('onYouTubeIframeAPIReady');
      createHiddenPlayer();
    };
  }

  function createHiddenPlayer() {
    if (ytPlayer) return;
    const mount = document.createElement('div');
    mount.id = 'yt-hidden-player-mount';
    mount.style.position = 'fixed';
    mount.style.left = '-9999px';
    mount.style.top = '-9999px';
    mount.style.width = '1px';
    mount.style.height = '1px';
    mount.style.pointerEvents = 'none';
    document.body.appendChild(mount);
    log('Creazione player nascosto');

    ytPlayer = new YT.Player(mount.id, {
      height: '1',
      width: '1',
      playerVars: {
        autoplay: 0,
        controls: 0,
        disablekb: 1,
        fs: 0,
        modestbranding: 1,
        playsinline: 1,
        origin: window.location.origin,
      },
      events: {
        onReady: function () {
          playerReady = true;
          log('YouTube hidden player ready');
          if (pendingTrack) {
            log('play pendingTrack on ready', pendingTrack.youtubeId);
            playYouTubeTrack(pendingTrack.youtubeId, pendingTrack.startedAt);
            pendingTrack = null;
          }
        },
        onStateChange: function (e) {
          log('YT state', e.data);
          emitState(e.data);
          // As soon as playback actually starts, drop the mute we used to sneak past
          // the browser's autoplay policy.
          if (e.data === YT.PlayerState.PLAYING && unlocked) {
            try { ytPlayer.unMute(); } catch (err) {}
          }
        },
        onError: function (e) {
          warn('YT player error', e);
        },
      },
    });
  }

  function playYouTubeTrack(youtubeId, startedAtMs) {
    if (!ytApiReady || !playerReady || !ytPlayer || typeof ytPlayer.loadVideoById !== 'function') {
      warn('YouTube player non pronto, chiameremo play quando pronto.');
      pendingTrack = { youtubeId, startedAt: startedAtMs };
      loadYouTubeIframeApi();
      return;
    }
    const elapsedSeconds = Math.max(0, (Date.now() - startedAtMs) / 1000);
    log('loadVideoById', youtubeId, 'startSeconds=', elapsedSeconds);

    // Start muted: browsers always allow muted autoplay. If the user has already
    // unlocked audio once this session, we unmute as soon as playback begins
    // (see onStateChange above). This makes playback survive track changes that
    // are triggered by realtime events rather than a fresh click.
    try { ytPlayer.mute(); } catch (e) {}
    ytPlayer.loadVideoById({ videoId: youtubeId, startSeconds: elapsedSeconds });
    setTimeout(() => {
      try {
        ytPlayer.playVideo();
        log('tentativo playVideo()');
      } catch (e) {
        warn('playVideo error', e);
      }
    }, 300);
  }

  function stopYouTubeTrack() {
    if (ytPlayer && typeof ytPlayer.stopVideo === 'function') {
      ytPlayer.stopVideo();
      log('stopVideo called');
    }
  }

  function setYouTubeVolume(percent) {
    if (ytPlayer && typeof ytPlayer.setVolume === 'function') {
      ytPlayer.setVolume(percent);
      log('setVolume', percent);
    }
  }

  function getCurrentTime() {
    if (ytPlayer && typeof ytPlayer.getCurrentTime === 'function') {
      try { return ytPlayer.getCurrentTime(); } catch (e) { return 0; }
    }
    return 0;
  }

  function getDuration() {
    if (ytPlayer && typeof ytPlayer.getDuration === 'function') {
      try { return ytPlayer.getDuration(); } catch (e) { return 0; }
    }
    return 0;
  }

  function unlockYouTubeAudio() {
    unlocked = true;
    if (!ytApiReady) {
      loadYouTubeIframeApi();
      log('unlock requested: API not ready, loading');
      return;
    }
    if (ytPlayer && typeof ytPlayer.playVideo === 'function') {
      try {
        ytPlayer.unMute();
        ytPlayer.playVideo();
        log('unlock attempted: unMute() + playVideo() called');
      } catch (e) {
        warn('unlock playVideo error', e);
      }
    }
  }

  window.ChinoFMYouTube = {
    init: loadYouTubeIframeApi,
    play: playYouTubeTrack,
    stop: stopYouTubeTrack,
    setVolume: setYouTubeVolume,
    unlock: unlockYouTubeAudio,
    getCurrentTime: getCurrentTime,
    getDuration: getDuration,
  };

  loadYouTubeIframeApi();
})();
