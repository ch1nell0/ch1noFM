const path = require('path');
const fs = require('fs');
const youtubeDl = require('yt-dlp-exec');
const { uploadWithFallback } = require('./uploader');

/**
 * Normalizza gli URL convertendo istanze alternative o proxy in link nativi di YouTube
 */
function normalizeUrl(inputUrl) {
  try {
    const parsed = new URL(inputUrl);
    
    // Gestione Typetype / Invidious / Istanza custom
    if (parsed.hostname.includes('typetype.video')) {
      const videoId = parsed.searchParams.get('v');
      if (videoId) {
        return `https://www.youtube.com/watch?v=${videoId}`;
      }
    }
    
    return inputUrl;
  } catch (e) {
    return inputUrl;
  }
}

/**
 * Handler per l'endpoint /download
 */
async function handleDownload(req, res) {
  const rawUrl = req.query.url || req.body.url;

  if (!rawUrl) {
    return res.status(400).json({ error: 'URL mancante' });
  }

  // 1. Sanificazione dell'URL
  const cleanUrl = normalizeUrl(rawUrl);
  console.log(`[Download] URL originale: ${rawUrl} -> URL processato: ${cleanUrl}`);

  // Preparazione file temporaneo di destinazione
  const outputFileName = `audio_${Date.now()}.mp3`;
  const outputPath = path.join('/tmp', outputFileName);

  try {
    // 2. Esecuzione yt-dlp
    console.log('[yt-dlp] Inizio estrazione...');
    await youtubeDl(cleanUrl, {
      output: outputPath,
      extractAudio: true,
      audioFormat: 'mp3',
      noWarnings: true,
      noPlaylist: true,
      format: 'bestaudio/best',
      cookies: fs.existsSync('/tmp/yt-cookies.txt') ? '/tmp/yt-cookies.txt' : undefined
    });

    if (!fs.existsSync(outputPath)) {
      throw new Error('Il file audio non è stato generato su disco.');
    }

    // 3. Caricamento tramite la cascata di Upload
    const uploadedUrl = await uploadWithFallback(outputPath);

    // 4. Pulizia del file locale temporaneo
    fs.unlinkSync(outputPath);

    // Risposta con il link finale
    return res.json({
      success: true,
      url: uploadedUrl
    });

  } catch (error) {
    console.error('[Download Error]:', error.message);

    // Pulizia file in caso di errore a metà processo
    if (fs.existsSync(outputPath)) {
      fs.unlinkSync(outputPath);
    }

    return res.status(500).json({
      error: 'Download o upload fallito',
      details: error.message
    });
  }
}

module.exports = { handleDownload };
