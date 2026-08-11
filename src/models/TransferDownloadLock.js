import mongoose from "mongoose";

/**
 * Verrou d'unicité d'un téléchargement de transfert.
 *
 * Un même téléchargement traverse plusieurs endpoints (proxy fichier par
 * fichier, marquage de fin côté public, ZIP natif) : sans verrou, le compteur
 * était incrémenté une fois par fichier PLUS une fois à la fin, et le
 * propriétaire recevait autant de mails. Ce verrou garantit l'inverse : le
 * téléchargement est comptabilisé et notifié quel que soit le chemin emprunté,
 * mais une seule fois.
 *
 * La clé combine le transfert et l'identifiant de session émis par la page
 * publique à chaque clic — donc trois téléchargements successifs comptent bien
 * pour trois. À défaut de session (téléchargement direct hors interface), on
 * retombe sur une empreinte du téléchargeur bornée dans le temps.
 *
 * L'index TTL ne fait que le ménage : la fenêtre logique est portée par
 * `notifiedAt` (voir transferDownloadService).
 */
const transferDownloadLockSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
  },
  notifiedAt: {
    type: Date,
    required: true,
  },
});

// Nettoyage automatique : les verrous n'ont plus d'utilité passé la fenêtre
transferDownloadLockSchema.index(
  { notifiedAt: 1 },
  { expireAfterSeconds: 25 * 3600 },
);

const TransferDownloadLock = mongoose.model(
  "TransferDownloadLock",
  transferDownloadLockSchema,
);

export default TransferDownloadLock;
