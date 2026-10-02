/**
 * Informations d'un membre de l'espace pour pré-remplir une signature.
 *
 * Lecture des collections brutes `user`, `member` et `organization` : le
 * modèle Mongoose `User` ne déclare pas les champs Better Auth (`name`,
 * `lastName`, `phoneNumber`, `image` à la racine).
 */

import mongoose from "mongoose";

const { ObjectId } = mongoose.Types;

const clean = (v) => {
  const s = typeof v === "string" ? v.trim() : "";
  return s === "null" || s === "undefined" ? "" : s;
};

/** Identifiant sous ses deux formes : les collections Better Auth mélangent. */
function idForms(id) {
  const s = String(id);
  return ObjectId.isValid(s) ? [new ObjectId(s), s] : [s];
}

/**
 * Prénom et nom depuis le profil : `name` est le « nom complet » saisi par
 * l'utilisateur, `lastName` le nom seul quand il a été renseigné.
 */
export function splitName(fullName, lastName) {
  const full = clean(fullName);
  const last = clean(lastName);
  if (last) {
    const first = full.toLowerCase().endsWith(last.toLowerCase())
      ? full.slice(0, full.length - last.length).trim()
      : full;
    return { firstName: first, lastName: last };
  }
  const [firstName = "", ...rest] = full.split(/\s+/).filter(Boolean);
  return { firstName, lastName: rest.join(" ") };
}

const httpUrl = (v) => {
  const s = clean(v);
  return /^https?:\/\//i.test(s) ? s : "";
};

/**
 * Photo de profil : celle choisie dans Newbi (avatar, profil) d'abord, celle
 * du compte Google (image, 96 px) sinon. Première adresse http(s) valide :
 * une ancienne valeur invalide ne masque pas la suivante.
 */
export function photoUrl(user) {
  return (
    httpUrl(user?.avatar) ||
    httpUrl(user?.profile?.profilePictureUrl) ||
    httpUrl(user?.image) ||
    null
  );
}

/**
 * Adresses à essayer pour importer une photo dans une signature : une photo
 * Google est demandée en 512 px (l'adresse enregistrée donne 96 px, floue
 * une fois agrandie), puis à son adresse d'origine si la grande échoue.
 */
export function photoImportUrls(url) {
  if (!url) return [];
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return [url];
  }
  if (!/(^|\.)googleusercontent\.com$/i.test(host)) return [url];
  const large = url
    .replace(/=s\d+(-c)?$/, "=s512-c")
    .replace(/\/s\d+(-c)?\//, "/s512-c/");
  return large === url ? [url] : [large, url];
}

function displayName(user) {
  const { firstName, lastName } = splitName(user?.name, user?.lastName);
  return [firstName, lastName].filter(Boolean).join(" ") || user?.email || "";
}

function formatAddress(org) {
  const street = clean(org?.addressStreet);
  const city = [clean(org?.addressZipCode), clean(org?.addressCity)]
    .filter(Boolean)
    .join(" ");
  return [street, city].filter(Boolean).join(", ");
}

const db = () => mongoose.connection.db;

/** Membres de l'espace, dans l'ordre d'arrivée. */
export async function listWorkspaceMembers(workspaceId) {
  const members = await db()
    .collection("member")
    .find({ organizationId: { $in: idForms(workspaceId) } })
    .sort({ createdAt: 1 })
    .toArray();
  if (members.length === 0) return [];
  const users = await db()
    .collection("user")
    .find({ _id: { $in: members.flatMap((m) => idForms(m.userId)) } })
    .project({
      name: 1,
      lastName: 1,
      email: 1,
      image: 1,
      avatar: 1,
      "profile.profilePictureUrl": 1,
    })
    .toArray();
  const byId = new Map(users.map((u) => [String(u._id), u]));
  return members
    .map((m) => byId.get(String(m.userId)))
    .filter(Boolean)
    .map((u) => ({
      userId: String(u._id),
      name: displayName(u),
      email: clean(u.email),
      image: photoUrl(u),
    }));
}

export async function isWorkspaceMember(userId, workspaceId) {
  return Boolean(
    await db()
      .collection("member")
      .findOne({
        userId: { $in: idForms(userId) },
        organizationId: { $in: idForms(workspaceId) },
      }),
  );
}

/**
 * Données de signature d'un membre : ce qui le concerne lui (`person`) et ce
 * qui vient de l'entreprise (`company`), plus l'URL de sa photo.
 */
export async function memberSignatureProfile(userId, workspaceId) {
  const [user, org] = await Promise.all([
    db()
      .collection("user")
      .findOne({ _id: { $in: idForms(userId) } }),
    workspaceId
      ? db()
          .collection("organization")
          .findOne({ _id: { $in: idForms(workspaceId) } })
      : null,
  ]);
  const { firstName, lastName } = splitName(user?.name, user?.lastName);
  return {
    person: {
      identity: { firstName, lastName },
      contact: {
        email: clean(user?.email),
        mobile: clean(user?.phoneNumber) || clean(user?.profile?.phone),
      },
    },
    company: {
      identity: { company: clean(org?.companyName) || clean(org?.name) },
      contact: {
        phone: clean(org?.companyPhone),
        website: clean(org?.website),
        address: formatAddress(org),
      },
    },
    photoUrl: photoUrl(user),
  };
}
