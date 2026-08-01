// server/index.js
// Backend gratuito per JulyFM da deployare su Render.com (Web Service, piano Free).
// Sostituisce Firebase Storage: scarica l'audio (yt-dlp + ffmpeg) o riceve un file
// caricato dall'utente, poi lo carica su Litterbox (catbox.moe) che è gratuito,
// non richiede account, e restituisce un link diretto scaricabile/riproducibile.
//
// Firestore (coda + stato radio) resta lato client come prima: NON serve billing
// per quello, resta gratis sul piano Spark. L'unica cosa che costava era Storage.

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

// Multer salva i file caricati temporaneamente in RAM per poi girarli a Litterbox
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB, alza/abbassa a piacere
});

/**
 * Carica un buffer audio su Litterbox (scade dopo `time`, es. "1h","12h","24h","72h").
 * Nessuna autenticazione richiesta.
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
  // Litterbox risponde con l'URL diretto in plain text, es: https://litter.catbox.moe/xxxxx.mp3
  return res.data.trim();
}

/**
 * Fallback: catbox.moe "normale" (upload anonimo, file permanente finché non
 * viene ripulito manualmente). Usato solo se Litterbox risponde con errore,
 * perché a volte Litterbox è instabile essendo un servizio gratuito minore.
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
 * Secondo fallback, su un'infrastruttura DIVERSA da catbox/litterbox (che sono
 * la stessa azienda: se una è sotto blocco anti-abuso spesso lo è anche
 * l'altra). Pixeldrain è gratuito, upload anonimo, nessuna registrazione.
 */
async function uploadToPixeldrain(fileBuffer, fileName) {
  const form = new FormData();
  form.append("file", fileBuffer, fileName);

  const res = await axios.post("https://pixeldrain.com/api/file", form, {
    headers: form.getHeaders(),
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  // Risposta JSON: { id: "abc123", success: true }
  return `https://pixeldrain.com/api/file/${res.data.id}`;
}

/**
 * Prova Litterbox → Catbox → Pixeldrain in cascata. Logga il motivo esatto
 * di ogni fallimento (utile nei log di Render per capire cosa succede).
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

app.get("/", (req, res) => res.send("JulyFM backend attivo ✅"));

// --- Endpoint 1: link YouTube/SoundCloud/mp3 diretto -> scarica con yt-dlp e carica su Litterbox
app.post("/download", async (req, res) => {
  const { url: link } = req.body;
  if (!link) return res.status(400).json({ error: "URL mancante." });

  const outputFile = path.join(os.tmpdir(), `song_${Date.now()}.mp3`);

  try {
    const info = await ytDlp(link, {
      dumpSingleJson: true,
      noWarnings: true,
      noPlaylist: true,
      defaultSearch: "ytsearch1:",
      extractorArgs: "youtube:player_client=android",
    });
    const videoInfo = info.entries ? info.entries[0] : info;

    await ytDlp(link, {
      extractAudio: true,
      audioFormat: "mp3",
      output: outputFile,
      ffmpegLocation: ffmpegPath,
      noPlaylist: true,
      defaultSearch: "ytsearch1:",
      extractorArgs: "youtube:player_client=android",
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

// --- Endpoint 2: file audio caricato dall'utente -> passa dritto a Litterbox
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
