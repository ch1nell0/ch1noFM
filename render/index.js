const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const puppeteer = require("puppeteer");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
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

// --- ENGINE DOWNLOAD YOUTUBE ---
//
// IMPORTANTE: dal 2024/2025 YouTube ha reso molto più aggressivo il blocco
// delle richieste server-side (serve un "PO token"), e i vecchi trucchi
// (mirror API non ufficiali tipo y2mate/vkrdown, istanze pubbliche di Cobalt
// come co.wuk.sh) sono stati rimossi perché ORA SONO ROTTI O INAFFIDABILI:
// - co.wuk.sh (Cobalt) non riesce più a scaricare da YouTube (problema noto
//   e ancora aperto lato Cobalt).
// - y2mate.is / vkrdown sono scraper non ufficiali che YouTube blocca con
//   captcha o che cambiano endpoint senza preavviso.
//
// L'unico metodo davvero affidabile oggi è yt-dlp autenticato con i cookie
// di un vero account YouTube (loggato, non serve premium). Vedi il file
// README-cookies.md per la procedura in 2 minuti.
async function downloadYouTubeAudio(youtubeUrl) {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error("URL YouTube non valido (impossibile estrarre il video ID).");

  console.log(`[YouTube Engine] Download per ID: ${videoId}`);

  const outputFile = path.join(os.tmpdir(), `yt_${videoId}_${Date.now()}.mp3`);

  const baseArgs = {
    noWarnings: true,
    noPlaylist: true,
  };

  // Cookie di un account YouTube loggato (fortemente consigliato).
  // Su Render: Settings -> Secret Files -> crea /etc/secrets/cookies.txt
  // e imposta la env var YTDLP_COOKIES_PATH=/etc/secrets/cookies.txt
  //
  // IMPORTANTE: i Secret Files di Render sono montati READ-ONLY, ma yt-dlp
  // quando riceve --cookies non si limita a leggere il file: ci riscrive
  // sopra i cookie aggiornati a fine esecuzione. Su un file read-only questo
  // manda in crash yt-dlp con "OSError: Read-only file system". Per questo
  // copiamo il file in una posizione scrivibile in /tmp ad ogni richiesta,
  // e passiamo a yt-dlp quella copia.
  const cookiesSourcePath = process.env.YTDLP_COOKIES_PATH;
  let cookiesPath = null;
  if (cookiesSourcePath && fs.existsSync(cookiesSourcePath)) {
    cookiesPath = path.join(os.tmpdir(), `cookies_${Date.now()}.txt`);
    fs.copyFileSync(cookiesSourcePath, cookiesPath);
    baseArgs.cookies = cookiesPath;
  } else {
    console.warn(
      "[YouTube Engine] Nessun cookies.txt configurato (YTDLP_COOKIES_PATH). " +
      "Molti video falliranno per il blocco anti-bot di YouTube."
    );
  }

  // Plugin PO-token (opzionale): funziona SOLO se hai anche deployato e
  // stai facendo girare un servizio separato bgutil-pot-provider e
  // BGUTIL_POT_URL punta al suo indirizzo pubblico. Se non è configurato,
  // viene semplicemente ignorato invece di rompere tutto.
  if (process.env.BGUTIL_POT_URL) {
    baseArgs.pluginDirs = "./yt-dlp-plugins";
    baseArgs.extractorArgs = `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_POT_URL}`;
  }

  try {
    const info = await ytDlp(youtubeUrl, { ...baseArgs, dumpSingleJson: true });

    await ytDlp(youtubeUrl, {
      ...baseArgs,
      extractAudio: true,
      audioFormat: "mp3",
      output: outputFile,
      ffmpegLocation: ffmpegPath,
      format: "bestaudio/best",
    });

    const buffer = fs.readFileSync(outputFile);
    fs.unlinkSync(outputFile);

    return { buffer, title: info.title || "YouTube Track" };
  } catch (err) {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    const detail = err.stderr || err.message || String(err);
    console.error("[YouTube Engine] yt-dlp fallito:", detail);

    const hint = cookiesPath
      ? " YouTube potrebbe comunque bloccare le richieste dall'IP del server anche con i cookie (blocco anti-bot su IP datacenter): se il problema persiste, prova a esportare cookies.txt più di recente da una sessione YouTube attiva."
      : " Configura YTDLP_COOKIES_PATH con un cookies.txt di un account YouTube loggato: senza, YouTube blocca quasi tutte le richieste dai server.";
    throw new Error("Download YouTube fallito." + hint + " Dettaglio: " + detail.slice(0, 300));
  } finally {
    if (cookiesPath && fs.existsSync(cookiesPath)) fs.unlinkSync(cookiesPath);
  }
}

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
        audioUrl,
        title: title || "Traccia TypeType",
        artist: "TypeType Video",
      });
    } catch (err) {
      console.error("[Errore TypeType]:", err.message);
      return res.status(500).json({ error: "Download TypeType fallito: " + err.message });
    }
  }

  // CASO 2: YOUTUBE
  if (
    cleanLink.includes("youtube.com") ||
    cleanLink.includes("youtu.be") ||
    cleanLink.includes("music.youtube.com")
  ) {
    try {
      const { buffer, title } = await downloadYouTubeAudio(cleanLink);
      const audioUrl = await uploadAudio(buffer, `${Date.now()}_youtube.mp3`);

      return res.json({
        audioUrl,
        title: title,
        artist: "YouTube",
      });
    } catch (err) {
      console.error("[Errore Finale YouTube]:", err.message);
      return res.status(500).json({
        error: err.message,
      });
    }
  }

  // CASO 3: ALTRI SITI (SoundCloud, Bandcamp, Vimeo, TikTok, ecc.)
  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);
  try {
    const info = await ytDlp(cleanLink, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      format: "bestaudio/best",
      defaultSearch: "ytsearch1:",
    });
    const videoInfo = info.entries ? info.entries[0] : info;

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
      audioUrl,
      title: videoInfo.title || "Traccia sconosciuta",
      artist: videoInfo.uploader || videoInfo.artist || "Web Radio",
    });
  } catch (err) {
    console.error("[Errore yt-dlp Generico]:", err.message);
    return res.status(500).json({ error: "Download fallito: " + (err.stderr || err.message) });
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
