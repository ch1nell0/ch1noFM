const {onRequest} = require("firebase-functions/v2/https");
const admin = require("firebase-admin");
const axios = require("axios");
const FormData = require("form-data");
const ytDlp = require("yt-dlp-exec");
const fs = require("fs");
const path = require("path");
const os = require("os");

admin.initializeApp();
const db = admin.firestore();

/**
 * Uploads audio file buffer to Litterbox (temp storage).
 * @param {Buffer} fileBuffer - Audio file binary buffer.
 * @param {string} fileName - Name of the file.
 * @return {Promise<string>} Direct download URL.
 */
async function uploadToLitterbox(fileBuffer, fileName) {
  const form = new FormData();
  form.append("reqtype", "fileupload");
  form.append("time", "1h");
  form.append("fileToUpload", fileBuffer, fileName);

  const res = await axios.post(
      "https://litterbox.catbox.moe/resources/internals/api.php",
      form,
      {headers: form.getHeaders()},
  );
  return res.data;
}

exports.submitSong = onRequest(
    {cors: true, maxInstances: 2},
    async (req, res) => {
      try {
        const {
          link,
          requestedBy,
          requestedById,
          isFile,
          fileBase64,
          fileName,
        } = req.body;
        let finalAudioUrl = "";
        let songTitle = "Traccia Sconosciuta";
        let artistName = "Artista Sconosciuto";
        let durationSec = 180;
        let coverUrl = "";

        if (isFile && fileBase64) {
          const buffer = Buffer.from(fileBase64, "base64");
          finalAudioUrl = await uploadToLitterbox(
              buffer,
              fileName || "audio.mp3",
          );
          songTitle = fileName ?
            fileName.replace(/\.[^/.]+$/, "") :
            "File Locale";
        } else if (link) {
          const outputFormat = path.join(
              os.tmpdir(),
              `song_${Date.now()}.mp3`,
          );

          const info = await ytDlp(link, {
            dumpSingleJson: true,
            noWarnings: true,
            defaultSearch: "ytsearch1:",
          });

          const videoInfo = info.entries ? info.entries[0] : info;
          songTitle = videoInfo.title || "Traccia Live";
          artistName =
            videoInfo.uploader || videoInfo.artist || "Web Radio";
          durationSec = videoInfo.duration || 180;
          coverUrl = videoInfo.thumbnail || "";

          await ytDlp(link, {
            extractAudio: true,
            audioFormat: "mp3",
            output: outputFormat,
            defaultSearch: "ytsearch1:",
          });

          const audioBuffer = fs.readFileSync(outputFormat);
          finalAudioUrl = await uploadToLitterbox(
              audioBuffer,
              `${Date.now()}.mp3`,
          );
          fs.unlinkSync(outputFormat);
        } else {
          return res.status(400).send({
            error: "Fornisci un link o un file audio valido.",
          });
        }

        await db.collection("queue").add({
          title: songTitle,
          artist: artistName,
          audioUrl: finalAudioUrl,
          duration: parseInt(durationSec, 10),
          coverUrl: coverUrl,
          requestedBy: requestedBy || "Anonimo",
          requestedById: requestedById || "anon-guest",
          createdAt: admin.firestore.FieldValue.serverTimestamp(),
        });

        return res.send({
          success: true,
          message: "Canzone aggiunta in coda con successo!",
        });
      } catch (err) {
        console.error(err);
        return res.status(500).send({
          error: "Errore durante il caricamento: " + err.message,
        });
      }
    },
);

exports.advanceQueue = onRequest({cors: true}, async (req, res) => {
  const queueSnapshot = await db
      .collection("queue")
      .orderBy("createdAt", "asc")
      .limit(1)
      .get();

  if (queueSnapshot.empty) {
    await db.collection("radioState").doc("current").delete();
    return res.send({status: "Coda vuota"});
  }

  const nextSongDoc = queueSnapshot.docs[0];
  const nextSong = nextSongDoc.data();
  const now = admin.firestore.Timestamp.now();

  const cooldownSeconds = nextSong.duration * 2;
  const cooldownUntil = admin.firestore.Timestamp.fromMillis(
      now.toMillis() + cooldownSeconds * 1000,
  );

  await db.collection("users").doc(nextSong.requestedById).set(
      {cooldownUntil: cooldownUntil},
      {merge: true},
  );

  await db.collection("radioState").doc("current").set({
    ...nextSong,
    startTime: now,
    currentSkipVotes: [],
  });

  await nextSongDoc.ref.delete();
  return res.send({status: "Riproduzione avviata", title: nextSong.title});
});