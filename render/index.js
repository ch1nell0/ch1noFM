// server/index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
const ytDlp = require("yt-dlp-exec");
const ffmpegPath = require("ffmpeg-static");
const fs = require("fs");
const path = require("path");
const os = require("os");

const app = express();
app.use(cors());
app.use(express.json({ limit: "5mb" }));

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 },
});

const SECRET_COOKIES_PATH = "/etc/secrets/cookies.txt";
let cookiesFilePath = null;
if (fs.existsSync(SECRET_COOKIES_PATH)) {
  try {
    cookiesFilePath = path.join(os.tmpdir(), "yt-cookies.txt");
    fs.copyFileSync(SECRET_COOKIES_PATH, cookiesFilePath);
    console.log("Cookie YouTube caricati da Secret File.");
  } catch (err) {
    cookiesFilePath = null;
  }
}

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
  } catch (err1) {
    try {
      return await uploadToCatbox(fileBuffer, fileName);
    } catch (err2) {
      return await uploadToPixeldrain(fileBuffer, fileName);
    }
  }
}

app.get("/", (req, res) => res.send("ch1noFM backend attivo ✅"));

const DIRECT_AUDIO_EXTENSIONS = [".mp3", ".m4a", ".wav", ".ogg", ".flac", ".aac", ".webm", ".opus"];
function isDirectAudioUrl(url) {
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return DIRECT_AUDIO_EXTENSIONS.some((ext) => pathname.endsWith(ext));
  } catch {
    return false;
  }
}

/**
 * GESTORE DEDICATO PER TYPETYPE.VIDEO
 * Estrae l'ID video da link tipo https://watch.typetype.video/watch?v=tZ0xze7u_Ss
 * o dai link diretti ai segmenti.
 */
async function handleTypeTypeVideo(link) {
  let videoId = null;

  // Caso 1: URL pagina watch?v=...
  const watchMatch = link.match(/v=([a-zA-Z0-9_-]+)/);
  if (watchMatch) {
    videoId = watchMatch[1];
  }

  // Caso 2: URL /api/sabr/playback/...
  const sabrMatch = link.match(/\/playback\/([^\/]+)/);
  if (sabrMatch) {
    videoId = sabrMatch[1];
  }

  if (!videoId) return null;

  console.log(`[TypeType] Tentativo download per ID: ${videoId}`);

  // Proviamo a scaricare i segmenti dell'audio (traccia 140) usando l'ID estratto
  let segmentIndex = 0;
  let chunks = [];
  let keepGoing = true;

  while (keepGoing && segmentIndex < 300) {
    // Gestisce sia la rotta playback standard che quella con ID estratto
    const segUrl = `https://watch.typetype.video/api/sabr/playback/${videoId}/140/segment/${segmentIndex}?generation=0`;
    try {
      const res = await axios.get(segUrl, { 
        responseType: "arraybuffer", 
        timeout: 4000,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        }
      });
      chunks.push(Buffer.from(res.data));
      segmentIndex++;
    } catch (e) {
      keepGoing = false;
    }
  }

  if (chunks.length === 0) return null;

  console.log(`[TypeType] Assemblati ${chunks.length} segmenti per ${videoId}`);
  return Buffer.concat(chunks);
}

// --- Endpoint principale /download ---
app.post("/download", async (req, res) => {
  const { url: link } = req.body;
  if (!link) return res.status(400).json({ error: "URL mancante." });

  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);

  // --- 1. SE È UN LINK TYPETYPE.VIDEO ---
  if (link.includes("typetype.video")) {
    try {
      const audioBuffer = await handleTypeTypeVideo(link);
      if (audioBuffer) {
        const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}_typetype.m4a`);
        return res.json({
          audioUrl,
          title: "Traccia TypeType Video",
          artist: "TypeType",
        });
      } else {
        return res.status(500).json({ error: "Impossibile estrarre i segmenti da TypeType. Il video potrebbe essere privato o DRM." });
      }
    } catch (err) {
      return res.status(500).json({ error: "Errore durante l'elaborazione di TypeType: " + err.message });
    }
  }

  // --- 2. SE È UN LINK AUDIO DIRETTO (.mp3, .m4a) ---
  if (isDirectAudioUrl(link)) {
    try {
      const response = await axios.get(link, { responseType: "arraybuffer" });
      const audioBuffer = Buffer.from(response.data);
      const fileName = decodeURIComponent(new URL(link).pathname.split("/").pop());
      const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}_${fileName}`);

      return res.json({
        audioUrl,
        title: fileName.replace(/\.[^/.]+$/, ""),
        artist: "Link diretto",
      });
    } catch (err) {
      return res.status(500).json({ error: "Download diretto fallito: " + (err.response?.status || err.message) });
    }
  }

  // --- 3. SE È YOUTUBE / SOUNDCLOUD (CON FALLBACK ANTI-BOT) ---
  try {
    // Forziamo il client ios o android che NON richiede il controllo bot/cookies se il cookie fallisce
    const ytOptionsBase = {
      extractorArgs: "youtube:player_client=ios,android,web",
    };
    if (cookiesFilePath) {
      ytOptionsBase.cookies = cookiesFilePath;
    }

    const info = await ytDlp(link, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      format: "bestaudio/best",
      defaultSearch: "ytsearch1:",
      ...ytOptionsBase,
    });
    const videoInfo = info.entries ? info.entries[0] : info;

    await ytDlp(link, {
      extractAudio: true,
      audioFormat: "mp3",
      output: outputFile,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      format: "bestaudio/best",
      defaultSearch: "ytsearch1:",
      ...ytOptionsBase,
    });

    const audioBuffer = fs.readFileSync(outputFile);
    const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}.mp3`);

    res.json({
      audioUrl,
      title: videoInfo.title || "Traccia sconosciuta",
      artist: videoInfo.uploader || videoInfo.artist || "Web Radio",
    });
  } catch (err) {
    console.error("Errore /download YouTube:", err.stderr || err.message);
    res.status(500).json({ error: "Download fallito: " + (err.stderr || err.message) });
  } finally {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
});

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
app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT}`));
