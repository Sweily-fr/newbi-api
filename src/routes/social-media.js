import express from "express";
import storage from "../services/social/socialMediaStorage.js";
import logger from "../utils/logger.js";

/**
 * Images des posts réseaux sociaux (GET /social-media/<id>.jpg), publique :
 * Instagram, Facebook et TikTok viennent les chercher à cette adresse au
 * moment de publier. Le fichier est renvoyé tel quel, jamais une
 * redirection (refusée par TikTok), sous api.newbi.fr (domaine vérifié chez
 * TikTok avec newbi.fr). Identifiant aléatoire de 122 bits : impossible à
 * deviner.
 */
const router = express.Router();

router.get("/:file", async (req, res) => {
  const match = /^([0-9a-f-]{36})\.jpg$/.exec(String(req.params.file || ""));
  if (!match || !storage.isConfigured()) return res.status(404).end();
  try {
    const image = await storage.readImage(match[1]);
    if (!image) return res.status(404).end();
    res.set({
      "Content-Type": image.contentType || "image/jpeg",
      "Cache-Control": "public, max-age=31536000, immutable",
      // Affichée aussi par le site (autre origine) dans la fenêtre du post
      "Cross-Origin-Resource-Policy": "cross-origin",
      "X-Content-Type-Options": "nosniff",
    });
    if (image.contentLength)
      res.set("Content-Length", String(image.contentLength));
    if (typeof image.body?.pipe === "function") {
      image.body.on("error", (error) => {
        logger.warn(`[SocialMedia] Lecture interrompue : ${error.message}`);
        res.destroy(error);
      });
      return image.body.pipe(res);
    }
    const bytes = await image.body.transformToByteArray();
    return res.end(Buffer.from(bytes));
  } catch (error) {
    logger.error("[SocialMedia] Image illisible:", error);
    return res.status(502).end();
  }
});

export default router;
