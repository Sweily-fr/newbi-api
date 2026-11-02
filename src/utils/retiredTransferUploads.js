import { ApolloError } from "apollo-server-express";
import {
  checkSubscriptionActive,
  requireWorkspaceAction,
} from "../middlewares/rbac.js";

// Anciennes façons d'envoyer les fichiers d'un transfert (disque local de
// l'API, base64, morceaux par GraphQL, URL présignées sans contrôle de
// l'identifiant) : ni le site ni l'application mobile ne s'en servent (envoi
// multipart : startMultipartUpload, completeMultipartUpload,
// createFileTransferWithIdsR2), mais elles restaient appelables, sans les
// contrôles de durée, de paiement ni de taille du parcours actuel. Gardées
// dans le schéma (un client ancien reçoit un message clair), sans effet.
export const RETIRED_TRANSFER_UPLOADS = {
  fileTransfer: ["createFileTransfer", "createFileTransferBase64"],
  chunkUpload: ["uploadFileChunk", "createFileTransferWithIds"],
  chunkUploadR2: [
    "generatePresignedUploadUrls",
    "uploadFileChunkToR2",
    "uploadFileDirectToR2",
    "uploadBase64FileToR2",
  ],
};

export const RETIRED_TRANSFER_UPLOAD_MESSAGE =
  "Cette méthode d'envoi n'est plus disponible. Mettez à jour l'application ou utilisez le site.";

export function retireTransferUploads(resolvers, names) {
  for (const name of names) {
    if (!resolvers.Mutation?.[name]) {
      throw new Error(`Mutation ${name} introuvable`);
    }
    // Mêmes refus qu'avant (droit « Créer », abonnement) pour qui n'y a pas
    // droit ; pour les autres, la méthode est retirée
    resolvers.Mutation[name] = requireWorkspaceAction(
      "fileTransfers",
      "create",
    )(async (_parent, _args, context) => {
      await checkSubscriptionActive(context);
      throw new ApolloError(RETIRED_TRANSFER_UPLOAD_MESSAGE, "METHOD_RETIRED");
    });
  }
}
