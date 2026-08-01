const fs = require('fs');
const axios = require('axios');
const FormData = require('form-data');

/**
 * 1. Provider: Catbox
 * Limite: 200MB
 */
async function uploadToCatbox(filePath) {
  const form = new FormData();
  form.append('reqtype', 'fileupload');
  form.append('fileToUpload', fs.createReadStream(filePath));

  const response = await axios.post('https://catbox.moe/user/api.php', form, {
    headers: form.getHeaders(),
    timeout: 60000
  });

  if (response.data && typeof response.data === 'string' && response.data.startsWith('http')) {
    return response.data.trim();
  }
  throw new Error(`Risposta Catbox non valida: ${response.data}`);
}

/**
 * 2. Provider: Pixeldrain
 * Limite: 10GB
 */
async function uploadToPixeldrain(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const response = await axios.post('https://pixeldrain.com/api/file', form, {
    headers: form.getHeaders(),
    timeout: 60000
  });

  if (response.data && response.data.success) {
    return `https://pixeldrain.com/u/${response.data.id}`;
  }
  throw new Error(`Pixeldrain fallito: ${JSON.stringify(response.data)}`);
}

/**
 * 3. Provider: GoFile
 * Upload in 2 step (recupero server migliore + upload)
 */
async function uploadToGoFile(filePath) {
  // Step A: Ottieni il server server attivo
  const getServerRes = await axios.get('https://api.gofile.io/servers', { timeout: 10000 });
  if (getServerRes.data.status !== 'ok' || !getServerRes.data.data.servers.length) {
    throw new Error('Impossibile ottenere un server GoFile attivo');
  }

  const targetServer = getServerRes.data.data.servers[0].name;

  // Step B: Upload file
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const uploadRes = await axios.post(`https://${targetServer}.gofile.io/contents/uploadfile`, form, {
    headers: form.getHeaders(),
    timeout: 120000
  });

  if (uploadRes.data && uploadRes.data.status === 'ok') {
    return uploadRes.data.data.downloadPage;
  }
  throw new Error(`GoFile fallito: ${JSON.stringify(uploadRes.data)}`);
}

/**
 * 4. Provider: Storage/File.io (Fallback finale)
 * Genera link temporanei usa-e-getta
 */
async function uploadToStorageTo(filePath) {
  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  const response = await axios.post('https://file.io', form, {
    headers: form.getHeaders(),
    timeout: 60000
  });

  if (response.data && response.data.success) {
    return response.data.link;
  }
  throw new Error(`Storage/File.io fallito: ${JSON.stringify(response.data)}`);
}

/**
 * Gestore principale a cascata (Fallback manager)
 */
async function uploadWithFallback(filePath) {
  const providers = [
    { name: 'Catbox', fn: uploadToCatbox },
    { name: 'Pixeldrain', fn: uploadToPixeldrain },
    { name: 'GoFile', fn: uploadToGoFile },
    { name: 'Storage.to / File.io', fn: uploadToStorageTo }
  ];

  for (const provider of providers) {
    try {
      console.log(`[Upload] Tentativo con ${provider.name}...`);
      const url = await provider.fn(filePath);
      console.log(`[Upload] Successo con ${provider.name}: ${url}`);
      return url;
    } catch (error) {
      console.warn(`[Upload Warning] ${provider.name} fallito: ${error.message}. Provo il prossimo provider...`);
    }
  }

  throw new Error("Tutti i servizi di upload (Catbox, Pixeldrain, GoFile, Storage) hanno restituito un errore.");
}

module.exports = { uploadWithFallback };
