// name=render/index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const puppeteer = require("puppeteer");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();

app.use(express.static(path.join(__dirname, "..", "public")));

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

// --- HEALTH CHECK (per UptimeRobot / cron esterni) ---
app.get("/health", (req, res) => res.status(200).send("OK"));
app.get("/", (req, res) => res.status(200).send("ch1noFM backend attivo."));

// --- SISTEMA UPLOAD (Litterbox -> Catbox -> Pixeldrain) ---
async function uploadToLitterbox(fileBuffer, fileName, time = "12h") {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", time);
  form.append("fileToUpload", fileBuffer, fileName);

  const res = await axios.post(
    "https://litterbox.catbox.moe/resources/internals/api.php",
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );
  return res.data.trim();
}

async function uploadToCatbox(fileBuffer, fileName) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("fileToUpload", fileBuffer, fileName);

  const res = await axios.post(
    "https://catbox.moe/user/api.php",
    form,
    { headers: form.getHeaders(), maxBodyLength: Infinity, maxContentLength: Infinity }
  );
  return res.data.trim();
}

async function uploadToPixeldrain(fileBuffer, fileName) {
  const form = new FormData();
  form.append("file", fileBuffer, fileName);

  const res = await axios.post("https://pixeldrain.com/api/file", form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  return `https://pixeldrain.com/api/file/${res.data.id}`;
}

async function uploadAudio(fileBuffer, fileName) {
  try {
    return await uploadToLitterbox(fileBuffer, fileName);
  } catch (e1) {
    console.warn("[Litterbox fallito]:", e1.message);
    try {
      return await uploadToCatbox(fileBuffer, fileName);
    } catch (e2) {
      console.warn("[Catbox fallito]:", e2.message);
      return await uploadToPixeldrain(fileBuffer, fileName);
    }
  }
}

const PUPPETEER_LAUNCH_OPTIONS = {
  headless: "new",
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--disable-dev-shm-usage",
    "--disable-accelerated-2d-canvas",
    "--disable-gpu",
  ],
};

// --- SCRAPER DEDICATO: TYPETYPE.VIDEO ---
async function downloadFromTypeType(url) {
  console.log(`[TypeType] Avvio intercettazione headless per: ${url}`);
  const browser = await puppeteer.launch(PUPPETEER_LAUNCH_OPTIONS);
  const page = await browser.newPage();

  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  const chunks = [];
  let videoTitle = "Traccia TypeType";

  page.on("response", async (response) => {
    const reqUrl = response.url();
    if (
      reqUrl.includes("/sabr/") ||
      reqUrl.includes("/segment/") ||
      reqUrl.includes(".m4s") ||
      reqUrl.includes("googlevideo.com")
    ) {
      try {
        const buf = await response.buffer();
        if (buf && buf.length > 0) chunks.push(buf);
      } catch (err) {}
    }
  });

  try {
    await page.goto(url, { waitUntil: "networkidle2", timeout: 35000 });
    try {
      const t = await page.title();
      if (t) videoTitle = t.replace(" - TypeType", "").trim();
    } catch (e) {}

    await new Promise((r) => setTimeout(r, 7000));
  } finally {
    await browser.close();
  }

  if (chunks.length === 0) {
    throw new Error("Nessun segmento audio/video intercettato da TypeType.");
  }

  return {
    buffer: Buffer.concat(chunks),
    title: videoTitle,
  };
}

function getYouTubeId(url) {
  const match = url.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// --- METADATI YOUTUBE VIA OEMBED (endpoint pubblico ufficiale, no scraping) ---
async function getYouTubeMeta(videoId, originalUrl) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const res = await axios.get(oembedUrl, { timeout: 8000 });
    return {
      title: res.data.title || "YouTube Track",
      artist: res.data.author_name || "YouTube",
    };
  } catch (err) {
    console.warn("[YouTube oEmbed] fallito, uso fallback generico:", err.message);
    return { title: "YouTube Track", artist: "YouTube" };
  }
}

// --- FALLBACK: YTMDL (usato quando yt-dlp fallisce sui siti generici) ---
// Richiede: Python 3 + `pip install ytmdl` disponibili nell'ambiente Render
// (aggiungi un build step, es. `pip install ytmdl` nel build command).
// ytmdl si appoggia a ffmpeg per la conversione: gli passiamo la cartella
// di ffmpeg-static nel PATH cosi lo trova anche se non e' installato a livello di sistema.
function runYtmdl(url, songNameHint, outDir, fileBaseName) {
  return new Promise((resolve, reject) => {
    const args = [
      "-q",                 // non chiedere conferme, prendi il primo risultato
      "-o", outDir,         // cartella di output
      "--filename", fileBaseName,
      "--url", url,         // link diretto da scaricare (bypassa la ricerca per l'audio)
      songNameHint || url,  // usato solo per i metadati/tag
    ];

    const child = spawn("ytmdl", args, {
      env: {
        ...process.env,
        PATH: `${path.dirname(ffmpegPath)}${path.delimiter}${process.env.PATH || ""}`,
      },
    });

    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("ytmdl: timeout (60s) superato."));
    }, 60000);

    child.stderr.on("data", (d) => { stderr += d.toString(); });
    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(new Error("ytmdl non disponibile sul server: " + err.message));
    });
    child.on("close", (code) => {
      clearTimeout(timeout);
      if (code !== 0) {
        return reject(new Error(`ytmdl fallito (exit ${code}): ${stderr.slice(-400)}`));
      }
      resolve();
    });
  });
}

async function downloadWithYtmdlFallback(link) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytmdl-"));
  const fileBase = `track_${Date.now()}`;
  try {
    await runYtmdl(link, null, tmpDir, fileBase);

    const files = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
    if (files.length === 0) throw new Error("ytmdl non ha prodotto alcun file mp3.");

    const filePath = path.join(tmpDir, files[0]);
    const buffer = fs.readFileSync(filePath);
    const audioUrl = await uploadAudio(buffer, `${Date.now()}_ytmdl.mp3`);

    return {
      source: "file",
      audioUrl,
      title: files[0].replace(/\.mp3$/i, ""),
      artist: "Web Radio",
    };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

// --- ENRICHMENT: copertina album + info artista, con fallback a catena ---
// Nessuna delle fonti sotto richiede una API key (tranne Last.fm, opzionale
// se imposti la env var LASTFM_API_KEY su Render).
const enrichCache = new Map(); // key: "title|artist" -> { data, ts }
const ENRICH_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore
const MB_USER_AGENT = "ch1noFM/1.0 (webradio tra amici)";

function cacheGet(key) {
  const hit = enrichCache.get(key);
  if (!hit) return null;
  if (Date.now() - hit.ts > ENRICH_CACHE_TTL) { enrichCache.delete(key); return null; }
  return hit.data;
}
function cacheSet(key, data) {
  enrichCache.set(key, { data, ts: Date.now() });
  if (enrichCache.size > 500) {
    const oldestKey = enrichCache.keys().next().value;
    enrichCache.delete(oldestKey);
  }
}

// --- Copertina: iTunes -> Deezer -> MusicBrainz/CoverArtArchive ---
async function coverFromItunes(title, artist) {
  const term = `${artist} ${title}`.trim();
  const { data } = await axios.get("https://itunes.apple.com/search", {
    params: { term, entity: "song", limit: 1 },
    timeout: 6000,
  });
  const hit = data.results && data.results[0];
  if (!hit || !hit.artworkUrl100) return null;
  return hit.artworkUrl100.replace("100x100bb", "600x600bb");
}

async function coverFromDeezer(title, artist) {
  const q = `${artist} ${title}`.trim();
  const { data } = await axios.get("https://api.deezer.com/search", {
    params: { q },
    timeout: 6000,
  });
  const hit = data.data && data.data[0];
  const cover = hit && hit.album && (hit.album.cover_xl || hit.album.cover_big || hit.album.cover_medium);
  return cover || null;
}

async function coverFromMusicBrainz(title, artist) {
  const query = `recording:"${title}" AND artist:"${artist}"`;
  const { data } = await axios.get("https://musicbrainz.org/ws/2/recording/", {
    params: { query, fmt: "json", limit: 1 },
    headers: { "User-Agent": MB_USER_AGENT },
    timeout: 7000,
  });
  const rec = data.recordings && data.recordings[0];
  const releaseId = rec && rec.releases && rec.releases[0] && rec.releases[0].id;
  if (!releaseId) return null;

  try {
    const artUrl = `https://coverartarchive.org/release/${releaseId}/front-500`;
    // Verifica che esista davvero prima di restituirla (HEAD per evitare di scaricare tutto).
    await axios.head(artUrl, { timeout: 6000, headers: { "User-Agent": MB_USER_AGENT } });
    return artUrl;
  } catch (e) {
    return null;
  }
}

async function findCoverArt(title, artist) {
  const sources = [coverFromItunes, coverFromDeezer, coverFromMusicBrainz];
  for (const source of sources) {
    try {
      const url = await source(title, artist);
      if (url) return url;
    } catch (e) {
      console.warn(`[cover:${source.name}] fallito:`, e.message);
    }
  }
  return null;
}

// --- Artista: Wikipedia (bio + foto) -> Deezer (foto) -> Last.fm opzionale ---
async function artistFromWikipedia(artist, lang) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artist)}`;
  const { data } = await axios.get(url, { timeout: 6000, headers: { "User-Agent": MB_USER_AGENT } });
  if (!data || data.type === "disambiguation") return null;
  return {
    bio: data.extract || null,
    photo: (data.thumbnail && data.thumbnail.source) || (data.originalimage && data.originalimage.source) || null,
    name: data.title || artist,
  };
}

async function artistFromDeezer(artist) {
  const { data } = await axios.get("https://api.deezer.com/search/artist", {
    params: { q: artist },
    timeout: 6000,
  });
  const hit = data.data && data.data[0];
  if (!hit) return null;
  return { bio: null, photo: hit.picture_xl || hit.picture_big || hit.picture_medium || null, name: hit.name };
}

async function artistFromLastfm(artist) {
  const apiKey = process.env.LASTFM_API_KEY;
  if (!apiKey) return null;
  const { data } = await axios.get("https://ws.audioscrobbler.com/2.0/", {
    params: { method: "artist.getinfo", artist, api_key: apiKey, format: "json" },
    timeout: 6000,
  });
  if (!data || !data.artist) return null;
  const bioRaw = data.artist.bio && data.artist.bio.summary;
  const bio = bioRaw ? bioRaw.replace(/<a[^>]*>.*?<\/a>/g, "").trim() : null;
  return { bio, photo: null, name: data.artist.name || artist };
}

async function findArtistInfo(artist) {
  if (!artist) return { bio: null, photo: null, name: null };

  let result = { bio: null, photo: null, name: artist };

  // Bio: Last.fm (se disponibile) -> Wikipedia IT -> Wikipedia EN
  const bioSources = [
    () => artistFromLastfm(artist),
    () => artistFromWikipedia(artist, "it"),
    () => artistFromWikipedia(artist, "en"),
  ];
  for (const source of bioSources) {
    try {
      const info = await source();
      if (info && info.bio) { result.bio = info.bio; result.name = info.name || result.name; }
      if (info && info.photo && !result.photo) result.photo = info.photo;
      if (result.bio && result.photo) break;
    } catch (e) {
      console.warn("[artistBio] fallito:", e.message);
    }
  }

  // Foto: se ancora mancante, prova Deezer
  if (!result.photo) {
    try {
      const info = await artistFromDeezer(artist);
      if (info && info.photo) result.photo = info.photo;
    } catch (e) {
      console.warn("[artistPhoto:deezer] fallito:", e.message);
    }
  }

  return result;
}

app.get("/enrich", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();
  if (!title && !artist) return res.status(400).json({ error: "title o artist mancanti." });

  const cacheKey = `${title}|${artist}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const [cover, artistInfo] = await Promise.all([
      findCoverArt(title, artist).catch(() => null),
      findArtistInfo(artist).catch(() => ({ bio: null, photo: null, name: artist })),
    ]);

    const result = {
      cover: cover || null,
      artistName: artistInfo.name || artist || null,
      artistBio: artistInfo.bio || null,
      artistPhoto: artistInfo.photo || null,
    };

    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    console.error("[Errore /enrich]:", err.message);
    res.status(500).json({ error: "Enrichment fallito: " + err.message });
  }
});

// --- ROUTE PRINCIPALE /DOWNLOAD ---
app.post("/download", async (req, res) => {
  const { url: link } = req.body || {};
  if (!link) return res.status(400).json({ error: "URL mancante." });

  const cleanLink = link.trim();

  // CASO 1: TYPETYPE VIDEO
  if (cleanLink.includes("typetype")) {
    try {
      const { buffer, title } = await downloadFromTypeType(cleanLink);
      const audioUrl = await uploadAudio(buffer, `${Date.now()}_typetype.m4a`);

      return res.json({
        source: "file",
        audioUrl,
        title: title || "Traccia TypeType",
        artist: "TypeType Video",
      });
    } catch (err) {
      console.error("[Errore TypeType]:", err.message);
      return res.status(500).json({ error: "Download TypeType fallito: " + err.message });
    }
  }

  // CASO 2: YOUTUBE -> niente download, solo ID + metadati.
  if (
    cleanLink.includes("youtube.com") ||
    cleanLink.includes("youtu.be") ||
    cleanLink.includes("music.youtube.com")
  ) {
    const videoId = getYouTubeId(cleanLink);
    if (!videoId) {
      return res.status(400).json({ error: "URL YouTube non valido (impossibile estrarre il video ID)." });
    }

    const meta = await getYouTubeMeta(videoId, cleanLink);

    return res.json({
      source: "youtube",
      youtubeId: videoId,
      title: meta.title,
      artist: meta.artist,
      startedAt: Date.now(),
    });
  }

  // CASO 3: ALTRI SITI (yt-dlp, con fallback su ytmdl se fallisce)
  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);
  try {
    let videoInfo;
    try {
      const info = await ytDlp(cleanLink, {
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        format: "bestaudio/best",
        defaultSearch: "ytsearch1:",
      });
      videoInfo = info.entries ? info.entries[0] : info;

      await ytDlp(cleanLink, {
        extractAudio: true,
        audioFormat: "mp3",
        output: outputFile,
        ffmpegLocation: ffmpegPath,
        noPlaylist: true,
        format: "bestaudio/best",
        defaultSearch: "ytsearch1:",
      });

      const audioBuffer = fs.readFileSync(outputFile);
      const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}.mp3`);

      return res.json({
        source: "file",
        audioUrl,
        title: videoInfo.title || "Traccia sconosciuta",
        artist: videoInfo.uploader || videoInfo.artist || "Web Radio",
      });
    } catch (ytDlpErr) {
      console.warn("[yt-dlp fallito, provo ytmdl]:", ytDlpErr.message);
      try {
        const fallbackResult = await downloadWithYtmdlFallback(cleanLink);
        return res.json(fallbackResult);
      } catch (ytmdlErr) {
        console.error("[Anche ytmdl fallito]:", ytmdlErr.message);
        throw new Error(
          `yt-dlp: ${ytDlpErr.stderr || ytDlpErr.message} | ytmdl: ${ytmdlErr.message}`
        );
      }
    }
  } catch (err) {
    console.error("[Errore download Generico]:", err.message);
    return res.status(500).json({ error: "Download fallito: " + err.message });
  } finally {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
});

// --- ROUTE PER UPLOAD LOCALE DI FILE ---
app.post("/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessun file ricevuto." });

  try {
    const safeName = `${Date.now()}_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const audioUrl = await uploadAudio(req.file.buffer, safeName);

    res.json({
      source: "file",
      audioUrl,
      title: req.file.originalname.replace(/\.[^/.]+$/, ""),
      artist: "Upload Locale",
    });
  } catch (err) {
    res.status(500).json({ error: "Upload fallito: " + err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
