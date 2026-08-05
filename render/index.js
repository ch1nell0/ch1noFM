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

// Optional plugin dir env (where you might mount custom yt-dlp plugins).
const YTDLP_PLUGIN_DIR = process.env.YTDLP_PLUGIN_DIR || "./yt-dlp-plugins";

// Show useful startup info
console.log("Starting backend...");
console.log("BGUTIL_POT_URL =", process.env.BGUTIL_POT_URL || "<not set>");
console.log("YTDLP_COOKIES_PATH =", process.env.YTDLP_COOKIES_PATH || "<not set>");
console.log("YTDLP_PLUGIN_DIR =", YTDLP_PLUGIN_DIR);

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

/**
 * Helper to build base args for yt-dlp calls.
 * Includes cookie handling, PO-token provider config (BGUTIL_POT_URL), plugin dir.
 */
function buildYtDlpBaseArgs() {
  const baseArgs = {
    noWarnings: true,
    noPlaylist: true,
  };

  // Cookie handling: copy secret file (read-only on Render) into /tmp so yt-dlp can update it.
  const cookiesSourcePath = process.env.YTDLP_COOKIES_PATH;
  if (cookiesSourcePath && fs.existsSync(cookiesSourcePath)) {
    const cookiesPath = path.join(os.tmpdir(), `cookies_${Date.now()}.txt`);
    try {
      fs.copyFileSync(cookiesSourcePath, cookiesPath);
      baseArgs.cookies = cookiesPath;
    } catch (e) {
      console.warn("[YouTube Engine] Impossibile copiare cookies:", e.message);
    }
  } else {
    console.warn(
      "[YouTube Engine] Nessun cookies.txt configurato (YTDLP_COOKIES_PATH). " +
      "Molti video falliranno per il blocco anti-bot di YouTube."
    );
  }

  // If a BGUTIL POT provider is configured, pass extractor args and plugin dir.
  if (process.env.BGUTIL_POT_URL) {
    baseArgs.pluginDirs = YTDLP_PLUGIN_DIR;
    baseArgs.extractorArgs = `youtubepot-bgutilhttp:base_url=${process.env.BGUTIL_POT_URL}`;
  }

  // Allow ffmpeg location override
  if (ffmpegPath) baseArgs.ffmpegLocation = ffmpegPath;

  return baseArgs;
}

// --- ENGINE DOWNLOAD YOUTUBE ---
async function downloadYouTubeAudio(youtubeUrl) {
  const videoId = getYouTubeId(youtubeUrl);
  if (!videoId) throw new Error("URL YouTube non valido (impossibile estrarre il video ID).");

  console.log(`[YouTube Engine] Download per ID: ${videoId}`);

  const outputFile = path.join(os.tmpdir(), `yt_${videoId}_${Date.now()}.mp3`);

  const baseArgs = buildYtDlpBaseArgs();

  try {
    const info = await ytDlp(youtubeUrl, { ...baseArgs, dumpSingleJson: true });

    await ytDlp(youtubeUrl, {
      ...baseArgs,
      extractAudio: true,
      audioFormat: "mp3",
      output: outputFile,
      format: "bestaudio/best",
    });

    const buffer = fs.readFileSync(outputFile);
    fs.unlinkSync(outputFile);

    return { buffer, title: info.title || "YouTube Track" };
  } catch (err) {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
    const detail = err.stderr || err.message || String(err);
    console.error("[YouTube Engine] yt-dlp fallito:", detail);

    const hint = process.env.BGUTIL_POT_URL
      ? " Verifica che il provider PO-token risponda correttamente e che yt-dlp sia aggiornato."
      : " Configura YTDLP_COOKIES_PATH con un cookies.txt di un account YouTube loggato: senza, YouTube blocca quasi tutte le richieste dai server.";
    throw new Error("Download YouTube fallito." + hint + " Dettaglio: " + (detail ? detail.slice(0, 300) : String(err)));
  } finally {
    // cleanup any temp cookies file if yt-dlp created one
    if (baseArgs && baseArgs.cookies && fs.existsSync(baseArgs.cookies)) {
      try { fs.unlinkSync(baseArgs.cookies); } catch (e) { /* ignore */ }
    }
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
    const baseArgs = buildYtDlpBaseArgs();

    const info = await ytDlp(cleanLink, {
      ...baseArgs,
      dumpSingleJson: true,
      format: "bestaudio/best",
      defaultSearch: "ytsearch1:",
    });
    const videoInfo = info.entries ? info.entries[0] : info;

    await ytDlp(cleanLink, {
      ...baseArgs,
      extractAudio: true,
      audioFormat: "mp3",
      output: outputFile,
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
