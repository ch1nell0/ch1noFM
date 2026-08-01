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

// Configurazione opzioni Puppeteer per ambienti senza GUI (Render)
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

// --- ESTRAZIONE ROBUSTA DI YOUTUBE SENZA YT-DLP ---
async function downloadYouTubeNoYtDlp(youtubeUrl) {
  console.log(`[YouTube API Engine] Download per: ${youtubeUrl}`);

  // Metodo 1: Cobalt API (Server Principale)
  try {
    const res = await axios.post(
      "https://api.cobalt.tools/api/json",
      { url: youtubeUrl, downloadMode: "audio", audioFormat: "mp3" },
      { headers: { Accept: "application/json", "Content-Type": "application/json" }, timeout: 15000 }
    );
    if (res.data && res.data.url) {
      const audioRes = await axios.get(res.data.url, { responseType: "arraybuffer", timeout: 30000 });
      return { buffer: Buffer.from(audioRes.data), title: res.data.filename || "YouTube Audio" };
    }
  } catch (e1) {
    console.warn("[Cobalt Main Fallito, provo Cobalt Mirror...]:", e1.message);
  }

  // Metodo 2: Cobalt API (Server Mirror/Alternativo)
  try {
    const res = await axios.post(
      "https://co.wuk.sh/api/json",
      { url: youtubeUrl, downloadMode: "audio", audioFormat: "mp3" },
      { headers: { Accept: "application/json", "Content-Type": "application/json" }, timeout: 15000 }
    );
    if (res.data && res.data.url) {
      const audioRes = await axios.get(res.data.url, { responseType: "arraybuffer", timeout: 30000 });
      return { buffer: Buffer.from(audioRes.data), title: res.data.filename || "YouTube Audio" };
    }
  } catch (e2) {
    console.warn("[Cobalt Mirror Fallito, provo Invidious...]:", e2.message);
  }

  // Metodo 3: Invidious API (Network Open Source Anti-Blocco)
  try {
    // Estraiamo l'ID del video da URL tipo youtube.com/watch?v=xxx o youtu.be/xxx
    const videoIdMatch = youtubeUrl.match(/(?:v=|\/live\/|\/shorts\/|youtu\.be\/)([a-zA-Z0-9_-]{11})/);
    if (!videoIdMatch) throw new Error("ID Video YouTube non valido.");
    const videoId = videoIdMatch[1];

    const invidiousRes = await axios.get(`https://invidious.nerdvpn.de/api/v1/videos/${videoId}`, { timeout: 15000 });
    const adaptiveFormats = invidiousRes.data.adaptiveFormats || [];
    
    // Trova la traccia audio con la miglior qualità
    const audioStream = adaptiveFormats
      .filter((f) => f.type && f.type.startsWith("audio/"))
      .sort((a, b) => (parseInt(b.bitrate) || 0) - (parseInt(a.bitrate) || 0))[0];

    if (!audioStream || !audioStream.url) throw new Error("Audio stream non trovato su Invidious.");

    const audioRes = await axios.get(audioStream.url, { responseType: "arraybuffer", timeout: 30000 });
    return { buffer: Buffer.from(audioRes.data), title: invidiousRes.data.title || "YouTube Track" };
  } catch (e3) {
    console.error("[Invidious Fallito]:", e3.message);
  }

  throw new Error("Tutti i servizi esterni di conversione YouTube sono momentaneamente non disponibili.");
}

// --- ROUTE PRINCIPALE /DOWNLOAD ---
app.post("/download", async (req, res) => {
  const { url: link } = req.body;
  if (!link) return res.status(400).json({ error: "URL mancante." });

  // Normalizza il link per i controlli
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

  // CASO 2: YOUTUBE (TOTALMENTE ISOLATO DA YT-DLP)
  if (
    cleanLink.includes("youtube.com") || 
    cleanLink.includes("youtu.be") || 
    cleanLink.includes("music.youtube.com")
  ) {
    try {
      const { buffer, title } = await downloadYouTubeNoYtDlp(cleanLink);
      const audioUrl = await uploadAudio(buffer, `${Date.now()}_youtube.mp3`);

      return res.json({
        audioUrl,
        title: title,
        artist: "YouTube",
      });
    } catch (err) {
      console.error("[Errore YouTube Engine]:", err.message);
      return res.status(500).json({ error: err.message });
    }
  }

  // CASO 3: TUTTI GLI ALTRI SITI (SoundCloud, Vimeo, TikTok, ecc. gestiti da YT-DLP)
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
