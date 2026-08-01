// server/index.js
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const axios = require("axios");
const FormData = require("form-data");
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

// --- SISTEMA DI UPLOAD FALLBACK (Litterbox -> Catbox -> Pixeldrain) ---
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

// --- SCRAPER HEADLESS PER TYPETYPE (Puppeteer) ---
async function downloadFromTypeType(url) {
  console.log(`[Puppeteer] Avvio browser headless per: ${url}`);
  
  const browser = await puppeteer.launch({
    headless: "new",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--disable-gpu"
    ],
  });

  const page = await browser.newPage();
  
  // Finiamo per simulare un browser reale
  await page.setUserAgent(
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  );

  const audioSegments = [];
  let title = "Traccia TypeType";

  // Intercettiamo TUTTA la rete per acchiappare i segmenti audio/video caricati dalla pagina
  page.on("response", async (response) => {
    const reqUrl = response.url();
    // Cerca gli endpoint dei segmenti audio/video di typetype
    if (reqUrl.includes("/sabr/") || reqUrl.includes("/segment/") || reqUrl.includes(".m4s") || reqUrl.includes(".mp4")) {
      try {
        const buffer = await response.buffer();
        if (buffer && buffer.length > 0) {
          audioSegments.push(buffer);
        }
      } catch (e) {
        // ignora segmenti corrotti/incompleti
      }
    }
  });

  try {
    // Navighiamo fino alla pagina del video
    await page.goto(url, { waitUntil: "networkidle2", timeout: 30000 });

    // Cerchiamo di estrarre il titolo dalla pagina
    try {
      const pageTitle = await page.title();
      if (pageTitle) title = pageTitle.replace(" - TypeType", "").trim();
    } catch (e) {}

    // Simuliamo un click sul player se il video non parte da solo
    try {
      await page.click("video, button.play, .play-button");
    } catch (e) {
      // Se non c'è un bottone visibile continua comunque
    }

    // Aspettiamo 6 secondi per consentire l'accumulo dei segmenti di rete
    await new Promise((r) => setTimeout(r, 6000));

  } catch (err) {
    console.error("[Puppeteer] Errore navigazione:", err.message);
  } finally {
    await browser.close();
  }

  if (audioSegments.length === 0) {
    throw new Error("Impossibile intercettare i dati della traccia audio da TypeType.");
  }

  console.log(`[Puppeteer] Intercettati ${audioSegments.length} blocchi di dati! Unione in corso...`);
  const finalBuffer = Buffer.concat(audioSegments);

  return {
    buffer: finalBuffer,
    title: title
  };
}

// --- ROTTE API ---

app.get("/", (req, res) => res.send("ch1noFM TypeType-Downloader attivo ✅"));

app.post("/download", async (req, res) => {
  const { url: link } = req.body;
  if (!link) return res.status(400).json({ error: "URL mancante." });

  // 1. GESTIONE TYPETYPE (con Puppeteer Headless)
  if (link.includes("typetype")) {
    try {
      const { buffer, title } = await downloadFromTypeType(link);
      const audioUrl = await uploadAudio(buffer, `${Date.now()}_typetype.m4a`);

      return res.json({
        audioUrl,
        title: title || "Traccia TypeType",
        artist: "TypeType Video",
      });
    } catch (err) {
      console.error("Errore TypeType:", err.message);
      return res.status(500).json({ error: "Download TypeType fallito: " + err.message });
    }
  }

  // 2. GESTIONE LINK DIRETTI (.mp3, .m4a, ecc.)
  try {
    const response = await axios.get(link, { responseType: "arraybuffer", timeout: 15000 });
    const audioBuffer = Buffer.from(response.data);
    const fileName = link.split("/").pop().split("?")[0] || "audio.mp3";
    const audioUrl = await uploadAudio(audioBuffer, `${Date.now()}_${fileName}`);

    return res.json({
      audioUrl,
      title: fileName.replace(/\.[^/.]+$/, ""),
      artist: "Link Diretto",
    });
  } catch (err) {
    return res.status(400).json({
      error: "Sito non supportato o link non valido. Inserisci un link TypeType o un file audio diretto (.mp3)."
    });
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
app.listen(PORT, () => console.log(`Server attivo sulla porta ${PORT}`));
