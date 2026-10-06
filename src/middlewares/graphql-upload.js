import { graphqlUploadExpress } from "graphql-upload";
import logger from "../utils/logger.js";

/**
 * graphqlUploadExpress, mais un multipart invalide (champ « operations »
 * manquant, fichier trop gros...) reçoit directement une réponse 4xx.
 * C'est une faute du client, le plus souvent un scanner : sans ça, le handler
 * Express par défaut imprime la stack dans les logs d'erreur à chaque requête.
 *
 * res.json passe par le send patché par graphql-upload, qui attend la fin de
 * la requête avant d'envoyer la réponse.
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
      next(error);
    });
  };
}
