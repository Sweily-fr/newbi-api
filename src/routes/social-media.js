import express from "express";
import { pipeline } from "stream";
import storage from "../services/social/socialMediaStorage.js";
import logger from "../utils/logger.js";

/**
 * Images et vidéos des posts réseaux sociaux (GET /social-media/<id>.jpg et
 * /social-media/<id>.mp4), publiques : Instagram, Facebook et TikTok
 * viennent les chercher à cette adresse au moment de publier. Le fichier
 * est renvoyé tel quel, jamais une redirection (refusée par TikTok), sous
 * api.newbi.fr (domaine vérifié chez TikTok avec newbi.fr). Identifiant
 * aléatoire de 122 bits : impossible à deviner.
 *
 * Vidéos : plages d'octets (Range, 206) et HEAD pris en charge, exigés par
 * TikTok (PULL_FROM_URL), Meta et la balise <video> de Safari.
 */
const router = express.Router();

const ID = "([0-9a-f-]{36})";
const IMAGE_FILE = new RegExp(`^${ID}\\.jpg$`);
const VIDEO_FILE = new RegExp(`^${ID}\\.mp4$`);

const COMMON_HEADERS = {
  "Cache-Control": "public, max-age=31536000, immutable",
  // Affichée aussi par le site (autre origine) dans la fenêtre du post
  "Cross-Origin-Resource-Policy": "cross-origin",
  "X-Content-Type-Options": "nosniff",
};

/** Envoie un corps R2 (flux) en libérant la lecture si le client s'en va. */
function sendBody(body, res, label) {
  if (typeof body?.pipe === "function") {
    pipeline(body, res, (error) => {
      if (error && error.code !== "ERR_STREAM_PREMATURE_CLOSE") {
        logger.warn(`[SocialMedia] ${label} interrompue : ${error.message}`);
      }
    });
    return;
  }
  body
    .transformToByteArray()
    .then((bytes) => res.end(Buffer.from(bytes)))
    .catch((error) => {
      logger.warn(`[SocialMedia] ${label} interrompue : ${error.message}`);
      res.destroy(error);
    });
}

/**
 * Plage demandée (une seule, « bytes=début-fin », « bytes=début- » ou
 * « bytes=-n ») d'un fichier de `size` octets.
 * @returns {{start: number, end: number}|null|"invalid"} null : fichier
 *   entier ; « invalid » : plage impossible (416)
 */
export function parseRange(header, size) {
  if (!header) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header).trim());
  // Plusieurs plages ou autre unité : fichier entier (permis par la norme)
  if (!match) return null;
  const [, rawStart, rawEnd] = match;
  if (rawStart === "" && rawEnd === "") return "invalid";
  let start;
  let end;
  if (rawStart === "") {
    const suffix = Number(rawEnd);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(rawStart);
    end = rawEnd === "" ? size - 1 : Math.min(Number(rawEnd), size - 1);
  }
  if (start >= size || end < start) return "invalid";
  return { start, end };
}

async function sendImage(id, res) {
  const image = await storage.readImage(id);
  if (!image) return res.status(404).end();
  res.set({
    ...COMMON_HEADERS,
    "Content-Type": image.contentType || "image/jpeg",
  });
  if (image.contentLength)
    res.set("Content-Length", String(image.contentLength));
  return sendBody(image.body, res, "Lecture d'image");
}

async function sendVideo(id, req, res) {
  const size = await storage.videoSize(id);
  if (size === null) return res.status(404).end();
  res.set({
    ...COMMON_HEADERS,
    "Content-Type": "video/mp4",
    "Accept-Ranges": "bytes",
  });
  const range = parseRange(req.headers.range, size);
  if (range === "invalid") {
    res.set("Content-Range", `bytes */${size}`);
    return res.status(416).end();
  }
  const start = range ? range.start : 0;
  const end = range ? range.end : size - 1;
  res.set("Content-Length", String(end - start + 1));
  if (range) {
    res.status(206).set("Content-Range", `bytes ${start}-${end}/${size}`);
  }
  if (req.method === "HEAD" || size === 0) return res.end();
  const video = await storage.readVideo(id, range ? { start, end } : {});
  if (!video) return res.status(404).end();
  return sendBody(video.body, res, "Lecture de vidéo");
}

router.get("/:file", async (req, res) => {
  const file = String(req.params.file || "");
  const image = IMAGE_FILE.exec(file);
  const video = VIDEO_FILE.exec(file);
  if ((!image && !video) || !storage.isConfigured()) {
    return res.status(404).end();
  }
  try {
    if (image) return await sendImage(image[1], res);
    return await sendVideo(video[1], req, res);
  } catch (error) {
    logger.error("[SocialMedia] Média illisible:", error);
    if (res.headersSent) return res.destroy(error);
    return res.status(502).end();
  }
});

export default router;
