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
// --- SERVER PO TOKEN (bgutil) ---
// yt-dlp da solo (anche con cookie) viene sempre più spesso respinto da YouTube con
// "Sign in to confirm you're not a bot". La soluzione ufficiale è generare dei PO Token
// (Proof-of-Origin) da allegare alle richieste. Il plugin Python (installato via pip nel
// build) si registra da solo in yt-dlp; qui avviamo SOLO il server Node.js che genera
// i token, in background, sulla porta di default 4416. Se il server non parte (es. build
// fallita), yt-dlp continua a funzionare normalmente ma senza il PO Token.
const BGUTIL_SERVER_ENTRY = path.join(__dirname, "bgutil-server-src", "server", "build", "main.js");
function startBgutilServer() {
  if (!fs.existsSync(BGUTIL_SERVER_ENTRY)) {
    console.warn("[bgutil] server non trovato (" + BGUTIL_SERVER_ENTRY + ") - PO Token disattivati, si va avanti senza.");
    return;
  }
  const child = spawn(process.execPath, [BGUTIL_SERVER_ENTRY], { stdio: ["ignore", "pipe", "pipe"] });
  child.stdout.on("data", (d) => console.log("[bgutil]", d.toString().trim()));
  child.stderr.on("data", (d) => console.warn("[bgutil]", d.toString().trim()));
  child.on("exit", (code) => {
    console.warn(`[bgutil] server terminato inaspettatamente (code ${code}), riavvio tra 5s...`);
    setTimeout(startBgutilServer, 5000);
  });
  console.log("[bgutil] server PO Token avviato in background sulla porta 4416.");
}
startBgutilServer();
const app = express();

// --- COOKIE YOUTUBE PER YT-DLP ---
// Fonti supportate, in ordine di priorità:
// 1) Secret File di Render "cookies.txt" -> montato in /etc/secrets/cookies.txt (sola lettura)
// 2) Env var YTDLP_COOKIES con il contenuto diretto del cookies.txt
//
// IMPORTANTE: qualunque sia la fonte, il contenuto viene sempre copiato in un file
// temporaneo SCRIVIBILE prima di passarlo a yt-dlp. yt-dlp, a fine esecuzione, prova
// a riscrivere il file dei cookie con eventuali aggiornamenti di sessione: se il path
// punta al Secret File (read-only) questo causa un crash (OSError: Read-only file system).
const YTDLP_COOKIES_TMP_PATH = path.join(os.tmpdir(), "yt-cookies.txt");
const RENDER_SECRET_COOKIES_PATH = "/etc/secrets/cookies.txt";
let cookiesResolved = false;
let cachedCookiesPath = null;

function getYtdlpCookiesPath() {
  if (cookiesResolved) return cachedCookiesPath;
  cookiesResolved = true;

  let rawContent = null;

  // 1) Secret File di Render
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

  // 2) Env var come fallback, solo se il Secret File non ha dato nulla
  if (!rawContent) {
    const raw = process.env.YTDLP_COOKIES;
    if (raw && raw.trim()) {
      const trimmed = raw.trim();
      if (trimmed.startsWith("/") || trimmed.startsWith("./")) {
        console.warn(
          "[cookies] YTDLP_COOKIES sembra un PERCORSO ('" + trimmed +
          "') e non il contenuto del file: la ignoro."
        );
      } else {
        rawContent = raw;
        console.log("[cookies] uso il contenuto di YTDLP_COOKIES.");
      }
    }
  }

  if (!rawContent) {
    console.warn("[cookies] Nessun cookie trovato: yt-dlp funzionerà solo finché YouTube non blocca l'IP del server.");
    return null;
  }

  // Copia SEMPRE in un file temporaneo scrivibile, indipendentemente dalla fonte.
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
  const base = cookiesPath ? { ...opts, cookies: cookiesPath } : { ...opts };
  base.extractorArgs = "youtube:player_client=web,android";
  return base;
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

// --- SPOTIFY: niente streaming reale (protetto), ma leggiamo titolo/artista/cover
// dalla pagina pubblica del brano e poi scarichiamo l'equivalente audio da YouTube ---
async function resolveSpotifyTrack(url) {
  const { data: html } = await axios.get(url, {
    headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36" },
    timeout: 8000,
  });

  const titleMatch = html.match(/<title>(.*?)<\/title>/i);
  const ogImageMatch = html.match(/<meta property="og:image" content="([^"]+)"/i);

  let title = null;
  let artist = null;

  if (titleMatch) {
    const raw = titleMatch[1].replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"');
    // Formato tipico della pagina Spotify: "Nome Brano - song by Artista1, Artista2 | Spotify"
    const m = raw.match(/^(.*?)\s*-\s*song (?:and lyrics )?by\s*(.*?)\s*\|\s*Spotify$/i);
    if (m) {
      title = m[1].trim();
      artist = m[2].trim();
    } else {
      title = raw.replace(/\s*\|\s*Spotify$/i, "").trim();
    }
  }

  if (!title) throw new Error("Impossibile leggere i metadati dalla pagina Spotify.");

  return { title, artist, cover: ogImageMatch ? ogImageMatch[1] : null };
}

async function downloadSpotifyViaYouTubeSearch(spotifyMeta, outputFile) {
  const searchQuery = spotifyMeta.artist ? `${spotifyMeta.artist} ${spotifyMeta.title}` : spotifyMeta.title;
  const searchTerm = `ytsearch1:${searchQuery}`;

  const info = await ytDlp(searchTerm, withCookies({
    dumpSingleJson: true,
    noWarnings: true,
    noPlaylist: true,
    format: "bestaudio/best",
  }));
  const videoInfo = info.entries ? info.entries[0] : info;

  await ytDlp(searchTerm, withCookies({
    extractAudio: true,
    audioFormat: "mp3",
    output: outputFile,
    ffmpegLocation: ffmpegPath,
    noPlaylist: true,
    format: "bestaudio/best",
  }));

  return videoInfo;
}

// --- METADATI YOUTUBE VIA OEMBED (endpoint pubblico ufficiale, no scraping) ---
async function getYouTubeMeta(videoId, originalUrl) {
  const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(
    `https://www.youtube.com/watch?v=${videoId}`
  )}&format=json`;

  try {
    const res = await axios.get(oembedUrl, { timeout: 8000 });
    const rawTitle = res.data.title || "YouTube Track";
    const channelName = res.data.author_name || "YouTube";
    const parsed = parseArtistTitle(rawTitle);

    return {
      title: parsed.title || rawTitle,
      // Se il titolo del video segue "Artista - Titolo" usiamo quello; altrimenti
      // teniamo il nome del canale solo come ultima spiaggia (verrà comunque
      // ricontrollato/corretto da /enrich tramite iTunes/Deezer/MusicBrainz).
      artist: parsed.artist || channelName,
      channelName,
    };
  } catch (err) {
    console.warn("[YouTube oEmbed] fallito, uso fallback generico:", err.message);
    return { title: "YouTube Track", artist: "YouTube", channelName: "YouTube" };
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

// --- Variante di ytmdl basata su ricerca testuale (nessun --url): usata per Spotify,
// dove non abbiamo un link YouTube diretto ma solo "Artista + Titolo" da cercare.
// NOTA: anche questa passa da yt-dlp/YouTube sotto il cofano, quindi soffre dello
// stesso blocco anti-bot finche' YTDLP_COOKIES non e' impostata.
function runYtmdlSearch(query, outDir, fileBaseName) {
  return new Promise((resolve, reject) => {
    const args = ["-q", "-o", outDir, "--filename", fileBaseName, query];

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

async function downloadWithYtmdlSearch(query) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ytmdl-search-"));
  const fileBase = `track_${Date.now()}`;
  try {
    await runYtmdlSearch(query, tmpDir, fileBase);
    const files = fs.readdirSync(tmpDir).filter((f) => f.toLowerCase().endsWith(".mp3"));
    if (files.length === 0) throw new Error("ytmdl non ha prodotto alcun file mp3.");
    const filePath = path.join(tmpDir, files[0]);
    const buffer = fs.readFileSync(filePath);
    const audioUrl = await uploadAudio(buffer, `${Date.now()}_ytmdl.mp3`);
    return { audioUrl, downloadedName: files[0].replace(/\.mp3$/i, "") };
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

// --- Copertina + ARTISTA CANONICO: iTunes -> Deezer -> MusicBrainz/CoverArtArchive ---
// Ogni fonte restituisce anche il nome artista che LEI ha trovato per quel brano:
// e' molto piu' affidabile del nome canale YouTube (che spesso e' un reupload/freebooter).
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

// Restituisce { cover, canonicalArtist } usando la prima fonte che da' un risultato utile,
// per una data coppia (title, artist).
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

// Molti reupload/freebooter mettono il titolo del video in ordine "Titolo - Artista"
// invece di "Artista - Titolo" (o viceversa), quindi non ci si puo' fidare ciecamente
// dell'ordine che abbiamo indovinato. Proviamo piu' combinazioni finche' una non da'
// un risultato, e ci fidiamo del nome artista restituito dal provider (non del nostro).
async function findCoverArt(title, artist) {
  const primaryArtist = stripFeaturedArtist(artist);
  const attempts = [];
  if (primaryArtist && primaryArtist !== artist) attempts.push([title, primaryArtist]);
  if (title || artist) attempts.push([title, artist]);
  if (title && artist) attempts.push([artist, title]); // ordine invertito
  if (title) attempts.push([title, null]); // solo titolo, nessun bias sull'artista

  for (const [t, a] of attempts) {
    const hit = await findCoverArtOnce(t, a).catch(() => ({ cover: null, canonicalArtist: null }));
    if (hit.cover || hit.canonicalArtist) return hit;
  }
  return { cover: null, canonicalArtist: null };
}

// --- Validazione nome: evita di accettare foto/bio di un artista omonimo o
// completamente sbagliato (es. la foto "Drake" restituita da Deezer che non era Drake). ---
function normalizeArtistName(s) {
  return (s || "")
    .toLowerCase()
    .replace(/\(.*?\)/g, "") // rimuove "(musician)", "(rapper)" ecc.
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "") // rimuove accenti
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

// --- Divide il credito artista in stile Spotify: artista/i principale/i + featured,
// cosi' possiamo mostrarli come schede separate e cliccabili. ---
function parseArtistCredits(rawArtist) {
  if (!rawArtist) return { primary: [], featured: [] };
  let primaryPart = rawArtist;
  let featuredPart = "";
  const ftMatch = rawArtist.match(/^(.*?)\s*(?:ft\.?|feat\.?|featuring)\s+(.+)$/i);
  if (ftMatch) {
    primaryPart = ftMatch[1];
    featuredPart = ftMatch[2];
  }
  const splitNames = (s) =>
    s.split(/\s*(?:&|,|\/| x |×)\s*/i).map((n) => n.trim()).filter(Boolean);
  return { primary: splitNames(primaryPart), featured: splitNames(featuredPart) };
}

// --- Artista: Wikipedia (bio + foto) -> Deezer (foto) -> Last.fm opzionale ---
async function artistFromWikipedia(artist, lang) {
  const url = `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(artist)}`;
  const { data } = await axios.get(url, { timeout: 6000, headers: { "User-Agent": MB_USER_AGENT } });
  if (!data || data.type === "disambiguation") return null;
  const name = data.title || artist;
  if (!namesRoughlyMatch(artist, name)) return null; // pagina non pertinente, la scartiamo
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
  if (!hit || !namesRoughlyMatch(artist, hit.name)) return null; // scarta match dubbi/omonimi
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

  // Last.fm per primo: e' l'unica fonte che ha pagine dedicate alle collaborazioni
  // (es. "Freddie Gibbs & Madlib"), che Wikipedia di solito non ha come pagina a se'.
  // Se LASTFM_API_KEY non e' impostata, questa fonte viene semplicemente saltata.
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
  const coverHint = (req.query.coverHint || "").toString().trim() || null;
  if (!title && !artist) return res.status(400).json({ error: "title o artist mancanti." });

  const cacheKey = `${title}|${artist}|${coverHint || ""}`;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(cached);

  try {
    // FASE 1: troviamo la copertina e, soprattutto, l'artista "vero" del brano
    // (non il nome del canale YouTube che l'ha ripubblicato).
    const { cover, canonicalArtist } = await findCoverArt(title, artist).catch(() => ({ cover: null, canonicalArtist: null }));
    const resolvedArtist = canonicalArtist || artist || null;

    // FASE 2: come fa Spotify, separiamo l'artista/i principale/i dai featured
    // (es. "Alchemist Ft. Nina Sky" -> principale: Alchemist, featured: Nina Sky;
    // "Freddie Gibbs & Madlib" -> entrambi principali, e' una collab vera e propria).
    // Ognuno viene cercato separatamente cosi' il frontend puo' mostrarli come
    // schede cliccabili distinte, invece di un'unica bio confusa.
    const credits = parseArtistCredits(resolvedArtist);
    const primaryNames = credits.primary.length ? credits.primary : (resolvedArtist ? [resolvedArtist] : []);
    const featuredNames = credits.featured.slice(0, 3); // limite di buon senso sulle chiamate esterne

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

  // CASO 2.5: SPOTIFY -> non scaricabile direttamente (protetto), risolviamo i
  // metadati (titolo/artista/cover) dalla pagina pubblica e cerchiamo l'audio
  // equivalente su YouTube (prima con yt-dlp diretto, poi con ytmdl come seconda
  // via). Entrambi passano da YouTube, quindi entrambi dipendono da YTDLP_COOKIES.
  if (cleanLink.includes("open.spotify.com")) {
    const spotifyOutputFile = path.join(os.tmpdir(), `spotify_${Date.now()}.mp3`);
    let spotifyMeta;
    try {
      spotifyMeta = await resolveSpotifyTrack(cleanLink);
    } catch (err) {
      console.error("[Errore Spotify - metadata]:", err.message);
      return res.status(500).json({ error: "Impossibile leggere i metadati da Spotify: " + err.message });
    }

    try {
      const videoInfo = await downloadSpotifyViaYouTubeSearch(spotifyMeta, spotifyOutputFile);
      const audioBuffer = fs.readFileSync(spotifyOutputFile);
      const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}_spotify.mp3`);

      return res.json({
        source: "file",
        audioUrl,
        title: spotifyMeta.title,
        artist: spotifyMeta.artist || videoInfo.uploader || "Spotify",
        // La cover di Spotify e' quasi sempre affidabile: la passiamo come suggerimento
        // cosi' /enrich puo' usarla senza dover cercare altrove.
        coverHint: spotifyMeta.cover || null,
      });
    } catch (ytDlpErr) {
      console.warn("[Spotify: yt-dlp diretto fallito, provo ytmdl]:", ytDlpErr.message);
      try {
        const query = spotifyMeta.artist ? `${spotifyMeta.artist} ${spotifyMeta.title}` : spotifyMeta.title;
        const ytmdlResult = await downloadWithYtmdlSearch(query);

        return res.json({
          source: "file",
          audioUrl: ytmdlResult.audioUrl,
          title: spotifyMeta.title,
          artist: spotifyMeta.artist || "Spotify",
          coverHint: spotifyMeta.cover || null,
        });
      } catch (ytmdlErr) {
        console.error("[Errore Spotify - anche ytmdl fallito]:", ytmdlErr.message);
        return res.status(500).json({
          error:
            "Download da Spotify fallito (yt-dlp: " + ytDlpErr.message + " | ytmdl: " + ytmdlErr.message + "). " +
            "Molto probabilmente serve impostare YTDLP_COOKIES su Render: YouTube sta bloccando l'IP del server.",
        });
      }
    } finally {
      if (fs.existsSync(spotifyOutputFile)) fs.unlinkSync(spotifyOutputFile);
    }
  }

  // CASO 3: ALTRI SITI (yt-dlp, con fallback su ytmdl se fallisce)
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
