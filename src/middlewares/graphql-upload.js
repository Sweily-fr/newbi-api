import { graphqlUploadExpress } from "graphql-upload";
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
      if (!error) stripOperatorKeys(req.body);
      next(error);
    });
  };
}
