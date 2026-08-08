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

// --- COOKIE YOUTUBE PER YT-DLP ---
// Usata SOLO dalla route "altri siti" (CASO 3) piu' sotto: link YouTube, Spotify,
// Deezer, Apple Music e Tidal non passano MAI da qui, quindi per la maggior parte
// dei brani richiesti questo blocco non serve nemmeno piu'. Lo teniamo per i link
// "generici" (mp3 diretti da altri siti) dove yt-dlp resta l'unica opzione.
//
// Fonti supportate, in ordine di priorita':
// 1) Secret File di Render "cookies.txt" -> montato in /etc/secrets/cookies.txt (sola lettura)
// 2) Env var YTDLP_COOKIES con il contenuto diretto del cookies.txt
const YTDLP_COOKIES_TMP_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
const RENDER_SECRET_COOKIES_PATH = "/etc/secrets/cookies.txt";
let cookiesResolved = false;
let cachedCookiesPath = null;

function getYtdlpCookiesPath() {
  if (cookiesResolved) return cachedCookiesPath;
  cookiesResolved = true;

  let rawContent = null;

  try {
    if (fs.existsSync(RENDER_SECRET_COOKIES_PATH)) {
      const content = fs.readFileSync(RENDER_SECRET_COOKIES_PATH, "utf8");
      if (content && content.trim().length > 50) {
        rawContent = content;
        console.log("[cookies] letto Secret File di Render.");
      } else {
        console.warn("[cookies] Secret File trovato ma troppo piccolo/vuoto, lo ignoro.");
      }
    }
  } catch (e) {
    console.warn("[cookies] errore leggendo il Secret File:", e.message);
  }

  if (!rawContent) {
    const raw = process.env.YTDLP_COOKIES;
    if (raw && raw.trim()) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("/") || trimmed.startsWith("./")) {
        console.warn("[cookies] YTDLP_COOKIES sembra un PERCORSO ('" + trimmed + "') e non il contenuto del file: la ignoro.");
      } else {
        rawContent = raw;
        console.log("[cookies] uso il contenuto di YTDLP_COOKIES.");
      }
    }
  }

  if (!rawContent) {
    console.warn("[cookies] Nessun cookie trovato: la route 'altri siti' funzionera' solo finche' l'IP del server non viene bloccato.");
    return null;
  }

  try {
    fs.writeFileSync(YTDLP_COOKIES_TMP_PATH, rawContent);
    cachedCookiesPath = YTDLP_COOKIES_TMP_PATH;
    return cachedCookiesPath;
  } catch (e) {
    console.warn("[cookies] impossibile scrivere il file temporaneo:", e.message);
    return null;
  }
}

function withCookies(opts) {
  const cookiesPath = getYtdlpCookiesPath();
  return cookiesPath ? { ...opts, cookies: cookiesPath } : { ...opts };
}

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
// Usato solo per upload manuali di file locali e per la route "altri siti".
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

// --- PARSING TITOLO: prova a estrarre "Artista - Titolo" dal titolo del video ---
// I canali freebooter/reupload mettono il loro nome come uploader, non come artista:
// meglio fidarsi del titolo del video (che spesso segue la convenzione "Artista - Titolo")
// e poi lasciare che iTunes/Deezer/MusicBrainz confermino/correggano l'artista reale.
function cleanupVideoTitle(raw) {
  if (!raw) return raw;
  return raw
    .replace(/\(?\[?(official\s*)?(music\s*)?video\)?\]?/gi, "")
    .replace(/\(?\[?(official\s*)?(lyric[s]?\s*)?video\)?\]?/gi, "")
    .replace(/\(?\[?(official\s*)?audio\)?\]?/gi, "")
    .replace(/\(?\[?lyrics?\)?\]?/gi, "")
    .replace(/\(?\[?hd\)?\]?/gi, "")
    .replace(/\(?\[?4k\)?\]?/gi, "")
    .replace(/\(?\[?visualizer\)?\]?/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function parseArtistTitle(rawTitle) {
  const cleaned = cleanupVideoTitle(rawTitle);
  const patterns = [/^(.+?)\s+-\s+(.+)$/, /^(.+?)\s*[:–—]\s*(.+)$/];
  for (const p of patterns) {
    const m = cleaned.match(p);
    if (m && m[1].trim() && m[2].trim()) {
      return { artist: m[1].trim(), title: m[2].trim() };
    }
  }
  return { artist: null, title: cleaned };
}

// --- METADATI YOUTUBE VIA OEMBED (endpoint pubblico ufficiale, no scraping) ---
function stripTopicSuffix(name) {
  if (!name) return name;
  // I canali "Artista - Topic" generati automaticamente da YouTube per gli artisti
  // ufficiali NON vanno trattati come nome canale/uploader generico: il testo prima
  // di " - Topic" e' proprio il nome dell'artista, quindi lo teniamo pulito.
  return name.replace(/\s*-\s*Topic\s*$/i, "").trim();
}

async function getYouTubeMeta(videoId, originalUrl) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const res = await axios.get(oembedUrl, { timeout: 8000 });
    const rawTitle = res.data.title || "YouTube Track";
    const channelName = stripTopicSuffix(res.data.author_name || "YouTube");
    const parsed = parseArtistTitle(rawTitle);

    return {
      title: parsed.title || rawTitle,
      artist: parsed.artist || channelName,
      channelName,
    };
  } catch (err) {
    console.warn("[YouTube oEmbed] fallito, uso fallback generico:", err.message);
    return { title: "YouTube Track", artist: "YouTube", channelName: "YouTube" };
  }
}

// --- RISOLUZIONE PIATTAFORME "SOLO METADATI" (Spotify, Deezer, Apple Music, Tidal) ---
// Questi servizi proteggono l'audio con DRM: non lo scarichiamo (ne' potremmo farlo
// legalmente). Leggiamo SOLO i metadati pubblici (titolo/artista/copertina) dalla loro
// pagina web, poi cerchiamo il brano corrispondente su YouTube tramite l'API ufficiale
// e lo riproduciamo esattamente come un link YouTube incollato a mano: player nascosto
// via iframe, nessun download, nessun yt-dlp coinvolto per questi link.
function detectMetadataOnlyPlatform(url) {
  if (url.includes("open.spotify.com")) return "spotify";
  if (url.includes("deezer.com")) return "deezer";
  if (url.includes("music.apple.com")) return "apple_music";
  if (url.includes("tidal.com") || url.includes("listen.tidal.com")) return "tidal";
  if (url.includes("soundcloud.com")) return "soundcloud";
  return null;
}

// Gli URL di Apple Music per un singolo brano finiscono con l'ID del catalogo iTunes
// (es. .../song/jet-set/285024166 -> id 285024166). Se lo troviamo, l'API iTunes
// Lookup e' molto piu' affidabile dello scraping del tag <title> della pagina.
function extractAppleMusicTrackId(url) {
  const m = url.match(/\/song\/[^/]+\/(\d+)/) || url.match(/[?&]i=(\d+)/);
  return m ? m[1] : null;
}

async function resolveAppleMusicViaItunesLookup(trackId) {
  const { data } = await axios.get("https://itunes.apple.com/lookup", {
    params: { id: trackId },
    timeout: 6000,
  });
  const hit = data.results && data.results[0];
  if (!hit || !hit.trackName) return null;
  return {
    title: hit.trackName,
    artist: hit.artistName || null,
    cover: hit.artworkUrl100 ? hit.artworkUrl100.replace("100x100bb", "600x600bb") : null,
  };
}

// SoundCloud ha un oEmbed pubblico ufficiale: titolo, autore (spesso l'artista, ma non
// sempre - i loro upload personali possono avere nomi account fuorvianti) e copertina.
async function resolveSoundCloudViaOembed(url) {
  const { data } = await axios.get("https://soundcloud.com/oembed", {
    params: { url, format: "json" },
    timeout: 8000,
  });
  if (!data || !data.title) return null;
  // Molti upload SoundCloud seguono comunque "Artista - Titolo" nel campo title,
  // stessa convenzione di YouTube: proviamo a separarli.
  const parsed = parseArtistTitle(data.title);
  return {
    title: parsed.title || data.title,
    artist: parsed.artist || data.author_name || null,
    cover: data.thumbnail_url || null,
  };
}

function decodeHtmlEntities(s) {
  if (!s) return s;
  return s
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
}

function extractPageMeta(html) {
  const og = (prop) => {
    const m = html.match(new RegExp(`<meta property="og:${prop}" content="([^"]+)"`, "i"));
    return m ? decodeHtmlEntities(m[1]) : null;
  };
  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  return {
    ogTitle: og("title"),
    ogImage: og("image"),
    titleTag: titleMatch ? decodeHtmlEntities(titleMatch[1]) : null,
  };
}

// Ogni piattaforma formatta il tag <title> in modo diverso: proviamo il pattern
// specifico e, se non matcha (i siti cambiano formato senza preavviso), ripieghiamo
// su una pulizia generica cosi' la ricerca funziona comunque, solo con l'artista
// separato dal titolo un po' meno preciso.
function parseTrackPageTitle(platform, rawTitle) {
  if (!rawTitle) return { title: null, artist: null };

  if (platform === "spotify") {
    const m = rawTitle.match(/^(.*?)\s*-\s*song (?:and lyrics )?by\s*(.*?)\s*\|\s*Spotify$/i);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
    return { title: rawTitle.replace(/\s*\|\s*Spotify$/i, "").trim(), artist: null };
  }

  if (platform === "deezer") {
    let m = rawTitle.match(/^(.*?)\s*-\s*(.*?)\s*-\s*[Ll]isten on Deezer\s*$/);
    if (m) return { artist: m[1].trim(), title: m[2].trim() };
    m = rawTitle.match(/^(.*?)\s+by\s+(.*?)\s*\|\s*Deezer\s*$/i);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
    return { title: rawTitle.replace(/\s*[-|]\s*Deezer.*$/i, "").trim(), artist: null };
  }

  if (platform === "apple_music") {
    let m = rawTitle.match(/^(.*?)\s*-\s*[Ss]ong by\s*(.*?)\s*-\s*Apple Music\s*$/);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
    m = rawTitle.match(/^(.*?)\s+by\s+(.*?)\s+on\s+Apple Music\s*$/i);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
    return { title: rawTitle.replace(/\s*[-|]\s*Apple Music.*$/i, "").trim(), artist: null };
  }

  if (platform === "tidal") {
    const m = rawTitle.match(/^(.*?)\s+by\s+(.*?)\s+on\s+TIDAL\s*$/i);
    if (m) return { title: m[1].trim(), artist: m[2].trim() };
    return { title: rawTitle.replace(/\s*[-|]\s*TIDAL.*$/i, "").trim(), artist: null };
  }

  return { title: rawTitle, artist: null };
}

async function resolveTrackPageMetadata(url, platform) {
  // Apple Music: se l'URL contiene l'ID del catalogo iTunes, e' molto piu' affidabile
  // dello scraping HTML - lo tentiamo per primo.
  if (platform === "apple_music") {
    const trackId = extractAppleMusicTrackId(url);
    if (trackId) {
      const viaLookup = await resolveAppleMusicViaItunesLookup(trackId).catch((e) => {
        console.warn("[apple_music:itunes-lookup] fallito:", e.message);
        return null;
      });
      if (viaLookup) return viaLookup;
    }
  }

  // SoundCloud: oEmbed ufficiale invece di scraping.
  if (platform === "soundcloud") {
    const viaOembed = await resolveSoundCloudViaOembed(url).catch((e) => {
      console.warn("[soundcloud:oembed] fallito:", e.message);
      return null;
    });
    if (viaOembed) return viaOembed;
  }

  const { data: html } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    timeout: 8000,
  });

  const meta = extractPageMeta(html);
  const rawTitle = meta.titleTag || meta.ogTitle;
  if (!rawTitle) throw new Error(`Impossibile leggere i metadati dalla pagina (${platform}).`);

  const parsed = parseTrackPageTitle(platform, rawTitle);
  return {
    title: parsed.title || rawTitle,
    artist: parsed.artist || null,
    cover: meta.ogImage || null,
  };
}

// --- RICERCA YOUTUBE VIA API UFFICIALE (nessuno scraping, nessun yt-dlp) ---
// Serve una API key gratuita: console.cloud.google.com -> abilita "YouTube Data API v3"
// -> Credenziali -> crea API key -> impostala su Render come YOUTUBE_API_KEY.
// Piano gratuito: 10.000 unita'/giorno, una ricerca ne costa 100 -> 100 ricerche/giorno.
async function searchYouTubeVideoIdOnce(query) {
  const apiKey = process.env.YOUTUBE_API_KEY;
  if (!apiKey) {
    throw new Error("YOUTUBE_API_KEY non impostata su Render: impossibile cercare su YouTube senza l'API ufficiale.");
  }
  const { data } = await axios.get("https://www.googleapis.com/youtube/v3/search", {
    params: { part: "snippet", q: query, type: "video", maxResults: 1, key: apiKey },
    timeout: 8000,
  });
  const hit = data.items && data.items[0];
  if (!hit) return null;
  return {
    videoId: hit.id.videoId,
    title: decodeHtmlEntities(hit.snippet.title),
    channelTitle: stripTopicSuffix(hit.snippet.channelTitle),
  };
}

// Una singola query a volte non trova nulla (titoli con caratteri strani, brani poco
// noti, ecc.): proviamo piu' varianti, dalla piu' specifica alla piu' generica, e
// prendiamo il primo risultato utile.
async function searchYouTubeVideoId(title, artist) {
  const attempts = [];
  if (artist && title) attempts.push(`${artist} ${title}`);
  if (artist && title) attempts.push(`${artist} - ${title} official audio`);
  if (title) attempts.push(title);
  if (artist && title) attempts.push(`${title} ${artist}`);

  for (const q of attempts) {
    try {
      const hit = await searchYouTubeVideoIdOnce(q);
      if (hit) return hit;
    } catch (e) {
      throw e; // errori reali (quota, key mancante) vanno propagati, non ignorati in loop
    }
  }
  return null;
}

// --- FALLBACK: YTMDL (usato SOLO dalla route "altri siti" quando yt-dlp fallisce) ---
// Richiede: Python 3 + `pip install ytmdl` disponibili nell'ambiente Render.
function runYtmdl(url, songNameHint, outDir, fileBaseName) {
  return new Promise((resolve, reject) => {
    const args = ["-q", "-o", outDir, "--filename", fileBaseName, "--url", url, songNameHint || url];

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
      if (code !== 0) return reject(new Error(`ytmdl fallito (exit ${code}): ${stderr.slice(-400)}`));
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
const enrichCache = new Map(); // key: "title|artist|coverHint" -> { data, ts }
const ENRICH_CACHE_TTL = 1000 * 60 * 60 * 6; // 6 ore
// Wikipedia/MusicBrainz penalizzano (429) gli User-Agent senza contatti: qui mettiamo
// l'URL del repo cosi' sanno chi contattare invece di limitarci piu' aggressivamente.
const MB_USER_AGENT = "ch1noFM/1.0 (webradio tra amici; https://github.com/ch1nell0/ch1noFM)";

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

// --- Copertina + ARTISTA CANONICO: iTunes -> Deezer -> MusicBrainz/CoverArtArchive ---
async function trackFromItunes(title, artist) {
  const term = `${artist || ""} ${title}`.trim();
  const { data } = await axios.get("https://itunes.apple.com/search", {
    params: { term, entity: "song", limit: 1 },
    timeout: 6000,
  });
  const hit = data.results && data.results[0];
  if (!hit) return null;
  return {
    cover: hit.artworkUrl100 ? hit.artworkUrl100.replace("100x100bb", "600x600bb") : null,
    artist: hit.artistName || null,
  };
}

async function trackFromDeezer(title, artist) {
  const q = `${artist || ""} ${title}`.trim();
  const { data } = await axios.get("https://api.deezer.com/search", {
    params: { q },
    timeout: 6000,
  });
  const hit = data.data && data.data[0];
  if (!hit) return null;
  return {
    cover: hit.album && (hit.album.cover_xl || hit.album.cover_big || hit.album.cover_medium),
    artist: hit.artist && hit.artist.name,
  };
}

async function trackFromMusicBrainz(title, artist) {
  const query = artist ? `recording:"${title}" AND artist:"${artist}"` : `recording:"${title}"`;
  const { data } = await axios.get("https://musicbrainz.org/ws/2/recording/", {
    params: { query, fmt: "json", limit: 1 },
    headers: { "User-Agent": MB_USER_AGENT },
    timeout: 7000,
  });
  const rec = data.recordings && data.recordings[0];
  if (!rec) return null;

  const canonicalArtist = rec["artist-credit"] && rec["artist-credit"].map((c) => c.name).join(" & ");
  const releaseId = rec.releases && rec.releases[0] && rec.releases[0].id;

  let cover = null;
  if (releaseId) {
    try {
      const artUrl = `https://coverartarchive.org/release/${releaseId}/front-500`;
      await axios.head(artUrl, { timeout: 6000, headers: { "User-Agent": MB_USER_AGENT } });
      cover = artUrl;
    } catch (e) { /* nessuna cover su Cover Art Archive per questa release */ }
  }

  return { cover, artist: canonicalArtist || null };
}

async function findCoverArtOnce(title, artist) {
  const sources = [trackFromItunes, trackFromDeezer, trackFromMusicBrainz];
  let cover = null;
  let canonicalArtist = null;

  for (const source of sources) {
    try {
      const hit = await source(title, artist);
      if (hit) {
        if (!cover && hit.cover) cover = hit.cover;
        if (!canonicalArtist && hit.artist) canonicalArtist = hit.artist;
      }
    } catch (e) {
      console.warn(`[track:${source.name}] fallito:`, e.message);
    }
    if (cover && canonicalArtist) break;
  }

  return { cover, canonicalArtist };
}

function stripFeaturedArtist(artist) {
  if (!artist) return artist;
  const m = artist.match(/^(.*?)\s*(?:ft\.?|feat\.?|featuring)\s+.+$/i);
  return m ? m[1].trim() : artist;
}

async function findCoverArt(title, artist) {
  const primaryArtist = stripFeaturedArtist(artist);
  const attempts = [];
  if (primaryArtist && primaryArtist !== artist) attempts.push([title, primaryArtist]);
  if (title || artist) attempts.push([title, artist]);
  if (title && artist) attempts.push([artist, title]); // ordine invertito
  if (title) attempts.push([title, null]);

  for (const [t, a] of attempts) {
    const hit = await findCoverArtOnce(t, a).catch(() => ({ cover: null, canonicalArtist: null }));
    if (hit.cover || hit.canonicalArtist) return hit;
  }
  return { cover: null, canonicalArtist: null };
}

// --- Validazione nome: evita di accettare foto/bio di un artista omonimo o sbagliato ---
function normalizeArtistName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "")
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/^the\s+/, "")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}
function namesRoughlyMatch(a, b) {
  const na = normalizeArtistName(a);
  const nb = normalizeArtistName(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  return na.includes(nb) || nb.includes(na);
}

function parseArtistCredits(rawArtist) {
  if (!rawArtist) return { primary: [], featured: [] };
  let primaryPart = rawArtist;
  let featuredPart = "";
  const ftMatch = rawArtist.match(/^(.*?)\s*(?:ft\.?|feat\.?|featuring)\s+(.+)$/i);
  if (ftMatch) {
    primaryPart = ftMatch[1];
    featuredPart = ftMatch[2];
  }
  const splitNames = (s) => s.split(/\s*(?:&|,|\/| x |×)\s*/i).map((n) => n.trim()).filter(Boolean);
  return { primary: splitNames(primaryPart), featured: splitNames(featuredPart) };
}

async function artistFromWikipedia(artist, lang) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artist)}`;
  const { data } = await axios.get(url, { timeout: 6000, headers: { "User-Agent": MB_USER_AGENT } });
  if (!data || data.type === "disambiguation") return null;
  const name = data.title || artist;
  if (!namesRoughlyMatch(artist, name)) return null;
  return {
    bio: data.extract || null,
    photo: (data.thumbnail && data.thumbnail.source) || (data.originalimage && data.originalimage.source) || null,
    name,
  };
}

async function artistFromDeezer(artist) {
  const { data } = await axios.get("https://api.deezer.com/search/artist", {
    params: { q: artist },
    timeout: 6000,
  });
  const hit = data.data && data.data[0];
  if (!hit || !namesRoughlyMatch(artist, hit.name)) return null;
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

// --- TRADUZIONE BIO ARTISTA (MyMemory, gratuita e senza API key) ---
// Limite gentile: ~500 caratteri a richiesta, ~5000/giorno anonimi. Per un uso
// personale tra amici e' piu' che sufficiente; tronchiamo se la bio e' molto lunga.
const translateCache = new Map(); // key: "lang|text" -> translated
app.get("/translate", async (req, res) => {
  const text = (req.query.text || "").toString().trim();
  const target = (req.query.target || "it").toString().trim();
  if (!text) return res.status(400).json({ error: "text mancante." });

  const cacheKey = `${target}|${text.slice(0, 200)}`;
  if (translateCache.has(cacheKey)) return res.json({ translated: translateCache.get(cacheKey) });

  const truncated = text.length > 490 ? text.slice(0, 490) + "…" : text;

  try {
    const { data } = await axios.get("https://api.mymemory.translated.net/get", {
      params: { q: truncated, langpair: `en|${target}` },
      timeout: 8000,
    });
    const translated = data && data.responseData && data.responseData.translatedText;
    if (!translated) throw new Error("Risposta di traduzione vuota.");
    translateCache.set(cacheKey, translated);
    if (translateCache.size > 300) translateCache.delete(translateCache.keys().next().value);
    res.json({ translated });
  } catch (err) {
    console.error("[Errore /translate]:", err.message);
    res.status(500).json({ error: "Traduzione fallita: " + err.message });
  }
});

app.get("/enrich", async (req, res) => {
  const title = (req.query.title || "").toString().trim();
  const artist = (req.query.artist || "").toString().trim();
  const coverHint = (req.query.coverHint || "").toString().trim() || null;
  if (!title && !artist) return res.status(400).json({ error: "title o artist mancanti." });

  const cacheKey = `${title}|${artist}|${coverHint || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    const { cover, canonicalArtist } = await findCoverArt(title, artist).catch(() => ({ cover: null, canonicalArtist: null }));
    const resolvedArtist = canonicalArtist || artist || null;

    const credits = parseArtistCredits(resolvedArtist);
    const primaryNames = credits.primary.length ? credits.primary : (resolvedArtist ? [resolvedArtist] : []);
    const featuredNames = credits.featured.slice(0, 3);

    const artists = [];
    for (const name of primaryNames.slice(0, 2)) {
      const info = await findArtistInfo(name).catch(() => null);
      artists.push({ name: (info && info.name) || name, role: "primary", bio: (info && info.bio) || null, photo: (info && info.photo) || null });
    }
    for (const name of featuredNames) {
      const info = await findArtistInfo(name).catch(() => null);
      artists.push({ name: (info && info.name) || name, role: "featured", bio: (info && info.bio) || null, photo: (info && info.photo) || null });
    }

    const result = {
      cover: coverHint || cover || null,
      artists,
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

  // CASO 2.5: SPOTIFY / DEEZER / APPLE MUSIC / TIDAL -> streaming protetto da DRM,
  // impossibile (e non lecito) scaricarlo direttamente. Leggiamo solo i metadati
  // pubblici della pagina (titolo, artista, copertina), cerchiamo il brano
  // corrispondente su YouTube con l'API ufficiale, e lo trattiamo ESATTAMENTE come
  // un link YouTube incollato a mano: nessun yt-dlp, nessun download, nessun upload,
  // solo player nascosto via iframe (stesso meccanismo del CASO 2).
  const metadataPlatform = detectMetadataOnlyPlatform(cleanLink);
  if (metadataPlatform) {
    try {
      const meta = await resolveTrackPageMetadata(cleanLink, metadataPlatform);

      const ytHit = await searchYouTubeVideoId(meta.title, meta.artist);
      if (!ytHit) throw new Error("Nessun video YouTube corrispondente trovato.");

      return res.json({
        source: "youtube",
        youtubeId: ytHit.videoId,
        title: meta.title || ytHit.title,
        artist: meta.artist || ytHit.channelTitle,
        coverHint: meta.cover || null,
        startedAt: Date.now(),
      });
    } catch (err) {
      console.error(`[Errore ${metadataPlatform}]:`, err.message);
      return res.status(500).json({
        error: `Impossibile risolvere il brano da ${metadataPlatform}: ` + err.message,
      });
    }
  }

  // CASO 3: ALTRI SITI (mp3 diretti o siti supportati da yt-dlp, con fallback su ytmdl)
  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);
  try {
    let videoInfo;
    try {
      const info = await ytDlp(cleanLink, withCookies({
        dumpSingleJson: true,
        noWarnings: true,
        noPlaylist: true,
        format: "bestaudio/best",
        defaultSearch: "ytsearch1:",
      }));
      videoInfo = info.entries ? info.entries[0] : info;

      await ytDlp(cleanLink, withCookies({
        extractAudio: true,
        audioFormat: "mp3",
        output: outputFile,
        ffmpegLocation: ffmpegPath,
        noPlaylist: true,
        format: "bestaudio/best",
        defaultSearch: "ytsearch1:",
      }));

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
        throw new Error(`yt-dlp: ${ytDlpErr.stderr || ytDlpErr.message} | ytmdl: ${ytmdlErr.message}`);
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

// --- UPLOAD IMMAGINE DI COPERTINA (dialog upload locale, cover personalizzata) ---
const uploadImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 8 * 1024 * 1024 },
});
app.post("/upload-image", uploadImage.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "Nessuna immagine ricevuta." });
  try {
    const safeName = `${Date.now()}_cover_${req.file.originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;
    const url = await uploadAudio(req.file.buffer, safeName); // funziona per qualunque binario, non solo audio
    res.json({ url });
  } catch (err) {
    res.status(500).json({ error: "Upload immagine fallito: " + err.message });
  }
});

const PORT = process.env.PORT || 10000;
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
