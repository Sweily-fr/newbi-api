import { graphqlUploadExpress, Upload } from "graphql-upload";
import logger from "../utils/logger.js";
import { stripOperatorKeys } from "./strip-mongo-operators.js";

/**
 * graphqlUploadExpress, mais un multipart invalide (champ « operations »
 * manquant, fichier trop gros...) reçoit directement une réponse 4xx.
 * C'est une faute du client, le plus souvent un scanner : sans ça, le handler
 * Express par défaut imprime la stack dans les logs d'erreur à chaque requête.
 *
 * res.json passe par le send patché par graphql-upload, qui attend la fin de
 * la requête avant d'envoyer la réponse.
 *
 * Le corps d'un multipart (champ « operations ») n'est lu qu'ici, après le
 * nettoyage des corps JSON : les clés « $… » (opérateurs MongoDB) y sont
 * retirées de la même façon.
 *
 * Un fichier n'est remis aux résolveurs qu'une fois entièrement reçu (voir
 * waitForFullUpload).
 */
export function graphqlUploadMiddleware(options) {
  const uploadMiddleware = graphqlUploadExpress(options);

  return (req, res, next) => {
    uploadMiddleware(req, res, (error) => {
      if (error?.expose && error.status >= 400 && error.status < 500) {
        logger.debug(
          `[Upload ${error.status}] ${req.method} ${req.originalUrl}: ${error.message}`,
        );
        return res.status(error.status).json({
          errors: [{ message: error.message }],
        });
      }
      if (!error) {
        stripOperatorKeys(req.body);
        deferUploadsUntilReceived(req.body);
      }
      next(error);
    });
  };
}

/**
 * Attend que le fichier soit entièrement écrit dans son tampon disque
 * (fs-capacitor) avant de le remettre au résolveur.
 *
 * fs-capacitor 6 (graphql-upload 13) a une course : une lecture lancée avant
 * l'écriture du dernier morceau renvoie 0 octet, et si l'écriture se termine
 * avant le retour de cette lecture, le flux est déclaré fini. Le résolveur
 * reçoit alors un fichier vide ou tronqué (petit PDF lu « pas un PDF valide »).
 * Une fois l'écriture finie, une lecture à 0 octet est une vraie fin de fichier.
 *
 * Un fichier refusé (trop gros) ou une requête coupée détruisent le tampon :
 * le fichier est rendu tel quel, createReadStream lève alors l'erreur d'origine.
 */
export function waitForFullUpload(file) {
  const capacitor = file?.capacitor;
  if (!capacitor || capacitor.writableFinished || capacitor.destroyed) {
    return Promise.resolve(file);
  }
  return new Promise((resolve) => {
    const done = () => {
      capacitor.off("finish", done);
      capacitor.off("close", done);
      capacitor.off("error", done);
      resolve(file);
    };
    capacitor.once("finish", done);
    capacitor.once("close", done);
    capacitor.once("error", done);
  });
}

const MAX_UPLOAD_DEPTH = 32;

/** Remplace la promesse de chaque fichier de la requête par celle du fichier entièrement reçu. */
export function deferUploadsUntilReceived(value, depth = 0) {
  if (value === null || typeof value !== "object" || depth > MAX_UPLOAD_DEPTH) {
    return;
  }
  if (value instanceof Upload) {
    const received = value.promise.then(waitForFullUpload);
    // Comme graphql-upload : un rejet non lu ne doit pas faire tomber Node.
    received.catch(() => {});
    value.promise = received;
    return;
  }
  for (const item of Array.isArray(value) ? value : Object.values(value)) {
    deferUploadsUntilReceived(item, depth + 1);
  }
}
