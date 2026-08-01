// server/index.js
// Backend gratuito per JulyFM / ch1noFM da deployare su Render.com (Web Service, piano Free).
// Sostituisce Firebase Storage: scarica l'audio (yt-dlp + ffmpeg o segmenti stream)
// o riceve un file caricato dall'utente, poi lo carica su Litterbox/Catbox/Pixeldrain.

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
app.use(express.json({ limit: "5mb" })); // JSON piccolo, i file passano da multer

// Multer salva i file caricati temporaneamente in RAM per poi girarli allo storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB
});

// Gestione Secret Files su Render per i cookie YouTube
const SECRET_COOKIES_PATH = "/etc/secrets/cookies.txt";
let cookiesFilePath = null;
if (fs.existsSync(SECRET_COOKIES_PATH)) {
  try {
    cookiesFilePath = path.join(os.tmpdir(), "yt-cookies.txt");
    fs.copyFileSync(SECRET_COOKIES_PATH, cookiesFilePath);
    console.log("Cookie YouTube trovati (Secret File), copiati in posizione scrivibile.");
  } catch (err) {
    console.error("Impossibile copiare i cookie YouTube:", err.message);
    cookiesFilePath = null;
  }
} else {
  console.log("Nessun cookie YouTube configurato: si userà il client android come fallback.");
}

/**
 * Carica un buffer audio su Litterbox (scade dopo `time`, es. "12h").
 */
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

/**
 * Fallback: catbox.moe "normale" (upload permanente).
 */
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

/**
 * Secondo fallback: Pixeldrain.
 */
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

/**
 * Prova Litterbox → Catbox → Pixeldrain in cascata.
 */
async function uploadAudio(fileBuffer, fileName) {
  try {
    return await uploadToLitterbox(fileBuffer, fileName);
  } catch (err1) {
    console.error(
      "Litterbox fallito, provo Catbox. Dettaglio:",
      err1.response?.status,
      err1.response?.data || err1.message
    );
    try {
      return await uploadToCatbox(fileBuffer, fileName);
    } catch (err2) {
      console.error(
        "Catbox fallito, provo Pixeldrain. Dettaglio:",
        err2.response?.status,
        err2.response?.data || err2.message
      );
      return await uploadToPixeldrain(fileBuffer, fileName);
    }
  }
}

app.get("/", (req, res) => res.send("ch1noFM / JulyFM backend attivo ✅"));

// Endpoint di Debug Formati
app.get("/formats", async (req, res) => {
  const link = req.query.url;
  if (!link) return res.status(400).send("Aggiungi ?url=... alla richiesta.");

  try {
    const ytOptionsBase = cookiesFilePath ? { cookies: cookiesFilePath } : {};
    const result = await ytDlp(link, {
      listFormats: true,
      noWarnings: true,
      noPlaylist: true,
      ...ytOptionsBase,
    });
    res.type("text/plain").send(typeof result === "string" ? result : JSON.stringify(result, null, 2));
  } catch (err) {
    res.status(500).type("text/plain").send(
      "Errore yt-dlp:\n" + (err.stderr || err.message || String(err))
    );
  }
});

// Controllo estensioni audio dirette
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
 * NUOVA FUNZIONE DI SUPPORTO:
 * Riconosce e assembla automaticamente gli stream a segmenti di piattaforme come typetype.video
 */
async function downloadSabrStream(url) {
  // Se l'URL fornito è già un endpoint di playback segmentato o della pagina
  const match = url.match(/(https:\/\/watch\.typetype\.video\/api\/sabr\/playback\/[^\/]+)/);
  if (!match) return null;

  const baseUrl = match[1];
  let segmentIndex = 0;
  let chunks = [];
  let keepGoing = true;

  console.log(`[SABR Stream] Inizio assemblaggio segmenti da: ${baseUrl}`);

  while (keepGoing && segmentIndex < 500) { // Limite di sicurezza 500 segmenti
    const segUrl = `${baseUrl}/140/segment/${segmentIndex}?generation=0`;
    try {
      const res = await axios.get(segUrl, { responseType: "arraybuffer", timeout: 5000 });
      chunks.push(Buffer.from(res.data));
      segmentIndex++;
    } catch (e) {
      keepGoing = false; // Quando la risposta restituisce 404/400 il flusso è finito
    }
  }

  if (chunks.length === 0) return null;
  
  console.log(`[SABR Stream] Scaricati ${chunks.length} segmenti con successo.`);
  return Buffer.concat(chunks);
}

// --- Endpoint 1: Download da URL (YouTube, SoundCloud, typetype, mp3 diretti) ---
app.post("/download", async (req, res) => {
  const { url: link } = req.body;
  if (!link) return res.status(400).json({ error: "URL mancante." });

  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);

  // --- Caso A: Stream a segmenti tipo typetype.video ---
  if (link.includes("watch.typetype.video")) {
    try {
      const sabrBuffer = await downloadSabrStream(link);
      if (sabrBuffer) {
        const audioUrl = await uploadAudio(sabrBuffer, `${Date.now()}_stream.m4a`);
        return res.json({
          audioUrl,
          title: "Stream typetype.video",
          artist: "Web Radio Stream",
        });
      }
    } catch (err) {
      console.error("Errore download SABR stream:", err.message);
    }
  }

  // --- Caso B: Link diretto ad un file audio (.mp3, .m4a, ecc.) ---
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
      console.error("Errore download diretto:", err.response?.status || err.message);
      return res.status(500).json({
        error: "Download diretto fallito: " + (err.response?.status || err.message),
      });
    }
  }

  // --- Caso C: YouTube e altri portali supportati da yt-dlp ---
  try {
    const ytOptionsBase = cookiesFilePath
      ? { cookies: cookiesFilePath }
      : { extractorArgs: "youtube:player_client=android" };

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
    console.error("Errore /download:", err.response?.data || err.message);
    res.status(500).json({ error: "Download fallito: " + (err.response?.data || err.message) });
  } finally {
    if (fs.existsSync(outputFile)) fs.unlinkSync(outputFile);
  }
});

// --- Endpoint 2: File audio caricato dall'utente ---
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
    console.error(err);
    res.status(500).json({ error: "Upload fallito: " + err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server avviato sulla porta ${PORT}`));
