const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const ytdl = require("@distube/ytdl-core");
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
    try {
      return await uploadToCatbox(fileBuffer, fileName);
    } catch (e2) {
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

// --- UTILITY PER ESTRARRE VIDEO ID ---
function extractYouTubeId(url) {
  const match = url.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
  return match ? match[1] : null;
}

// --- ENGINE MULTI-DOWNLOADER PER YOUTUBE (AGGIORNATO) ---
async function processYouTubeAudio(youtubeUrl) {
  console.log(`[YouTube Engine Multi-Provider] Elaborazione: ${youtubeUrl}`);
  const videoId = extractYouTubeId(youtubeUrl);

  if (!videoId) {
    throw new Error("URL di YouTube non valido (ID video non trovato).");
  }

  // --- LIVELLO 1: CNVMP3 API Engine ---
  try {
    console.log("[YouTube Engine] Tentativo 1: CNVMP3 API...");
    const initRes = await axios.post(
      "https://cnvmp3.com/api/convert",
      { url: youtubeUrl, format: "mp3", quality: "128" },
      {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Referer": "https://cnvmp3.com/",
          "Origin": "https://cnvmp3.com"
        },
        timeout: 10000
      }
    );

    if (initRes.data && (initRes.data.url || initRes.data.downloadUrl)) {
      const downloadLink = initRes.data.url || initRes.data.downloadUrl;
      const audioRes = await axios.get(downloadLink, { responseType: "arraybuffer", timeout: 30000 });
      return {
        buffer: Buffer.from(audioRes.data),
        title: initRes.data.title || "YouTube Track (CNVMP3)"
      };
    }
  } catch (e1) {
    console.warn(`[CNVMP3 API Fallito]: ${e1.message}`);
  }

  // --- LIVELLO 2: OGMP3 API Engine ---
  try {
    console.log("[YouTube Engine] Tentativo 2: OGMP3 Engine...");
    const ogRes = await axios.get(`https://ogmp3.com/api/ajax/search`, {
      params: { query: youtubeUrl, vt: "mp3" },
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
        "X-Requested-With": "XMLHttpRequest",
        "Referer": "https://ogmp3.com/"
      },
      timeout: 10000
    });

    if (ogRes.data && ogRes.data.links && ogRes.data.links.mp3) {
      const mp3Keys = Object.keys(ogRes.data.links.mp3);
      const k = ogRes.data.links.mp3[mp3Keys[0]].k;

      const convertRes = await axios.post(
        "https://ogmp3.com/api/ajax/convert",
        new URLSearchParams({ vid: videoId, k: k }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "X-Requested-With": "XMLHttpRequest"
          },
          timeout: 15000
        }
      );

      if (convertRes.data && convertRes.data.dlink) {
        const audioRes = await axios.get(convertRes.data.dlink, { responseType: "arraybuffer", timeout: 30000 });
        return {
          buffer: Buffer.from(audioRes.data),
          title: ogRes.data.title || "YouTube Track (OGMP3)"
        };
      }
    }
  } catch (e2) {
    console.warn(`[OGMP3 Engine Fallito]: ${e2.message}`);
  }

  // --- LIVELLO 3: Y2Meta Engine ---
  try {
    console.log("[YouTube Engine] Tentativo 3: Y2Meta Engine...");
    const y2Res = await axios.post(
      "https://y2meta.co.com/api/ajax/search",
      new URLSearchParams({ q: youtubeUrl, vt: "mp3" }),
      {
        headers: {
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "X-Requested-With": "XMLHttpRequest"
        },
        timeout: 10000
      }
    );

    if (y2Res.data && y2Res.data.links && y2Res.data.links.mp3) {
      const mp3Keys = Object.keys(y2Res.data.links.mp3);
      const key = y2Res.data.links.mp3[mp3Keys[0]].k;

      const convertRes = await axios.post(
        "https://y2meta.co.com/api/ajax/convert",
        new URLSearchParams({ vid: videoId, k: key }),
        {
          headers: {
            "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36"
          },
          timeout: 15000
        }
      );

      if (convertRes.data && convertRes.data.dlink) {
        const audioRes = await axios.get(convertRes.data.dlink, { responseType: "arraybuffer", timeout: 30000 });
        return {
          buffer: Buffer.from(audioRes.data),
          title: y2Res.data.title || "YouTube Track (Y2Meta)"
        };
      }
    }
  } catch (e3) {
    console.warn(`[Y2Meta Engine Fallito]: ${e3.message}`);
  }

  // --- LIVELLO 4: Fallback Nativo con Local yt-dlp Executable ---
  try {
    console.log("[YouTube Engine] Tentativo 4: yt-dlp-exec (Locale)...");
    const tempFile = path.join(os.tmpdir(), `yt_${Date.now()}.mp3`);

    await ytDlp(youtubeUrl, {
      extractAudio: true,
      audioFormat: "mp3",
      output: tempFile,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      format: "bestaudio/best"
    });

    if (fs.existsSync(tempFile)) {
      const buffer = fs.readFileSync(tempFile);
      fs.unlinkSync(tempFile);
      return {
        buffer: buffer,
        title: "YouTube Track (yt-dlp)"
      };
    }
  } catch (e4) {
    console.warn(`[yt-dlp Fallito]: ${e4.message}`);
  }

  throw new Error("Tutti i downloader alternativi (CNVMP3, OGMP3, Y2Meta, yt-dlp) hanno fallito o non sono raggiungibili.");
}

// --- ROUTE PRINCIPALE /DOWNLOAD ---
app.post("/download", async (req, res) => {
  const { url: link } = req.body;
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

  // CASO 2: YOUTUBE (Gestito dal nuovo motore multi-downloader)
  if (
    cleanLink.includes("youtube.com") || 
    cleanLink.includes("youtu.be") || 
    cleanLink.includes("music.youtube.com")
  ) {
    try {
      const { buffer, title } = await processYouTubeAudio(cleanLink);
      const audioUrl = await uploadAudio(buffer, `${Date.now()}_youtube.mp3`);

      return res.json({
        audioUrl,
        title: title,
        artist: "YouTube",
      });
    } catch (err) {
      console.error("[Errore Finale YouTube]:", err.message);
      return res.status(500).json({ error: "Download YouTube fallito: " + err.message });
    }
  }

  // CASO 3: TUTTI GLI ALTRI SITI (SoundCloud, Vimeo, TikTok, ecc.)
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
