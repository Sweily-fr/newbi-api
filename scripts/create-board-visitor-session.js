#!/usr/bin/env node

/**
 * Crée une session visiteur de longue durée sur un lien de partage kanban,
 * pour un client automatisé qui ne peut pas lire de code e-mail (routine
 * qui commente via addExternalComment). Les opérations visiteur exigent
 * désormais une session (l'e-mail déclaré ne suffit plus) : le client
 * envoie ce jeton dans `sessionToken` (getPublicBoard, addExternalComment,
 * publicTaskUpdated...).
 *
 * L'adresse est marquée comme vérifiée sans code : à réserver à une adresse
 * maîtrisée par l'équipe. Révocation : `logoutInvitedUser`, ou incrémenter
 * `sessionVersion` de l'utilisateur invité.
 *
 * Usage :
 *   NODE_ENV=production node scripts/create-board-visitor-session.js \
 *     --share-token <jeton du lien> --email <adresse> [--name <nom>] [--days 365]
 */

import "../src/config/env.js";
import mongoose from "mongoose";
import PublicBoardShare from "../src/models/PublicBoardShare.js";
import UserInvited from "../src/models/UserInvited.js";
import { createVisitorSessionToken } from "../src/utils/boardVisitorSession.js";

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : null;
};
const SHARE_TOKEN = argValue("--share-token");
const EMAIL = String(argValue("--email") || "")
  .toLowerCase()
  .trim();
const NAME = argValue("--name");
const DAYS = Number(argValue("--days")) || 365;

if (!SHARE_TOKEN || !EMAIL) {
  console.error(
    "Usage : --share-token <jeton> --email <adresse> [--name <nom>] [--days <n>]",
  );
  process.exit(1);
}
if (!process.env.MONGODB_URI) {
  console.error("MONGODB_URI requis");
  process.exit(1);
}

async function main() {
  await mongoose.connect(process.env.MONGODB_URI);
  try {
    const share = await PublicBoardShare.findOne({ token: SHARE_TOKEN });
    if (!share || !share.isValid()) {
      throw new Error("Lien de partage introuvable, désactivé ou expiré");
    }

    let userInvited = await UserInvited.findOne({ email: EMAIL });
    if (!userInvited) {
      userInvited = new UserInvited({ email: EMAIL, requiresPassword: false });
    }
    if (NAME) userInvited.firstName = NAME;
    userInvited.emailVerifiedAt = userInvited.emailVerifiedAt || new Date();
    await userInvited.save();
    await userInvited.addBoardAccess(
      share.boardId,
      share._id,
      share.workspaceId,
    );

    const sessionToken = createVisitorSessionToken(
      userInvited,
      share,
      DAYS * 24 * 60 * 60 * 1000,
    );
    console.log(`Session visiteur pour ${EMAIL}, valable ${DAYS} jours :`);
    console.log(sessionToken);
  } finally {
    await mongoose.disconnect();
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
