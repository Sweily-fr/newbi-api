/**
 * Harnais de simulation de la numérotation des documents (BC, devis, factures).
 *
 * Le principe : rejouer des enchaînements d'opérations réelles (créer, valider,
 * finaliser depuis l'éditeur, repasser en brouillon, annuler) et vérifier après
 * CHAQUE étape que la numérotation reste saine. Les trois types de documents
 * partagent la même mécanique (compteur atomique + verrou de séquence + index
 * unique incluant les brouillons), donc le même banc s'applique aux trois via
 * un adaptateur.
 */
import { expect } from "vitest";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";

import { seedOrgMembership } from "./auth.js";

/**
 * Démarre un replica set en mémoire. Nécessaire : les finalisations
 * (DRAFT → PENDING / CONFIRMED) s'exécutent dans une transaction MongoDB, que
 * mongod en mode standalone refuse.
 */
export async function startReplicaSet(dbPrefix) {
  const replSet = await MongoMemoryReplSet.create({
    replSet: { count: 1, storageEngine: "wiredTiger" },
  });
  await mongoose.connect(replSet.getUri(), {
    dbName: `${dbPrefix}_${process.pid}`,
  });
  return replSet;
}

/**
 * Construit les index déclarés AVANT de simuler. Mongoose les crée de façon
 * asynchrone : sans cette attente, les premières simulations tournent sans
 * contrainte d'unicité et le banc ne prouve plus rien.
 */
export async function ensureIndexes(model, expectedIndexName) {
  await model.init();
  const indexes = await model.collection.indexes();
  expect(
    indexes.some((i) => i.name === expectedIndexName),
    `l'index unique ${expectedIndexName} doit être en place avant les simulations`,
  ).toBe(true);
}

export async function resetWorkspace({ userId, organizationId }) {
  const collections = await mongoose.connection.db.collections();
  await Promise.all(collections.map((c) => c.deleteMany({})));
  await seedOrgMembership({ userId, organizationId, role: "owner" });
  await mongoose.connection.db.collection("organization").updateOne(
    { _id: organizationId },
    {
      $set: {
        capitalSocial: "10000",
        rcs: "Paris B 123 456 789",
        vatNumber: "FR12345678901",
      },
    },
  );
}

export const buildClient = () => ({
  name: "Contrepartie Test",
  email: "contrepartie@test.fr",
  address: {
    street: "10 avenue du Test",
    city: "Lyon",
    postalCode: "69001",
    country: "France",
  },
});

/** PRNG déterministe : chaque graine rejoue exactement le même enchaînement. */
export function makeRandom(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) % 4294967296;
    return state / 4294967296;
  };
}

/**
 * Invariants durs, valables quel que soit l'enchaînement :
 *  - tout numéro persisté respecte le validateur du modèle
 *  - aucun doublon de numéro parmi les documents finalisés
 *    (clé métier : préfixe + année + numéro)
 *
 * La continuité de la séquence n'est PAS exigée ici : repasser en brouillon un
 * document qui n'est pas le dernier sort son numéro des finalisés et laisse un
 * trou par construction. Elle est vérifiée séparément dans les scénarios écrits
 * à la main, où l'enchaînement est maîtrisé.
 */
export async function assertNumberingInvariants({
  adapter,
  organizationId,
  label,
  journal = [],
}) {
  const all = await adapter.model.find({ workspaceId: organizationId }).lean();
  const context = journal.length ? `\nJournal :\n${journal.join("\n")}` : "";

  for (const doc of all) {
    expect(
      adapter.numberValidator.test(doc.number),
      `${label}: numéro invalide "${doc.number}" (${doc.status})${context}`,
    ).toBe(true);
  }

  const finalized = all
    .filter((doc) => doc.status !== adapter.draftStatus)
    .map((doc) => `${doc.prefix}|${doc.issueYear}|${doc.number}`);
  expect(
    new Set(finalized).size,
    `${label}: doublon parmi les numéros finalisés${context}`,
  ).toBe(finalized.length);

  return all;
}

/**
 * Boucle de fuzz : `steps` opérations tirées au sort, invariants vérifiés après
 * chacune. Toute exception inattendue fait échouer le test avec le journal
 * complet de l'enchaînement, ce qui rend le scénario reproductible.
 */
export async function runNumberingFuzz({
  adapter,
  seed,
  steps,
  organizationId,
  ctx,
}) {
  const rand = makeRandom(seed);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];

  const docs = () => adapter.model.find({ workspaceId: organizationId }).lean();
  const drafts = async () =>
    (await docs()).filter((d) => d.status === adapter.draftStatus);
  const finalized = async () =>
    (await docs()).filter((d) => d.status === adapter.finalizedStatus);

  const journal = [];

  // Nomme l'opération pour que le message d'échec dise laquelle a cassé.
  const named = (opName, run) => {
    run.opName = opName;
    return run;
  };

  const operations = [
    // L'invariant central : le numéro proposé par l'éditeur doit TOUJOURS être
    // accepté. C'est exactement ce qui était cassé sur les bons de commande.
    named("créer finalisé", async () => {
      const proposed = await adapter.nextNumber(ctx);
      const created = await adapter.createFinalized(proposed, ctx);
      expect(created.number).toBe(proposed);
      return `créer finalisé ${proposed}`;
    }),
    named("créer brouillon", async () => {
      const draft = await adapter.createDraft(ctx);
      expect(draft.number).toMatch(/^DRAFT-/);
      return "créer brouillon";
    }),
    named("valider brouillon", async () => {
      const list = await drafts();
      if (!list.length) return "skip (aucun brouillon)";
      const target = pick(list);
      const res = await adapter.finalizeViaStatus(target._id, ctx);
      expect(res.status).toBe(adapter.finalizedStatus);
      return `valider brouillon → ${res.number}`;
    }),
    named("finaliser auto", async () => {
      const list = await drafts();
      if (!list.length) return "skip (aucun brouillon)";
      const target = pick(list);
      const res = await adapter.finalizeViaUpdate(target._id, null, ctx);
      expect(res.status).toBe(adapter.finalizedStatus);
      return `finaliser (auto) → ${res.number}`;
    }),
    named("finaliser avec numéro", async () => {
      const list = await drafts();
      if (!list.length) return "skip (aucun brouillon)";
      const target = pick(list);
      const proposed = await adapter.nextNumber(ctx);
      const res = await adapter.finalizeViaUpdate(target._id, proposed, ctx);
      if (adapter.finalizeKeepsReservedNumber) {
        // Facture : le numéro est réservé dès la création du brouillon
        // (DRAFT-0002 → 0002). Celui envoyé par l'éditeur est ignoré, on se
        // contente donc de vérifier qu'un numéro séquentiel a été attribué.
        expect(res.number).toMatch(/^\d+$/);
      } else {
        expect(res.number).toBe(proposed);
      }
      return `finaliser (numéro demandé ${proposed} → obtenu ${res.number})`;
    }),
  ];

  if (adapter.revertToDraft) {
    operations.push(
      named("repasser en brouillon", async () => {
        const list = await finalized();
        if (!list.length) return "skip (aucun document finalisé)";
        const target = pick(list);
        const res = await adapter.revertToDraft(target._id, ctx);
        expect(res.status).toBe(adapter.draftStatus);
        return `repasser ${target.number} en brouillon`;
      }),
    );
  }

  if (adapter.cancel) {
    operations.push(
      named("annuler", async () => {
        const list = await finalized();
        if (!list.length) return "skip (aucun document finalisé)";
        const target = pick(list);
        await adapter.cancel(target._id, ctx);
        return `annuler ${target.number}`;
      }),
    );
  }

  for (let step = 0; step < steps; step++) {
    let label;
    // Si l'opération tirée n'a rien à faire (aucun brouillon en base par
    // exemple), on retire jusqu'à en trouver une utile : chaque étape doit
    // exercer réellement un résolveur.
    for (let attempt = 0; attempt < 6; attempt++) {
      const op = pick(operations);
      try {
        label = await op();
      } catch (err) {
        throw new Error(
          `[${adapter.label}] graine ${seed}, étape ${step} (opération « ${op.opName} ») ` +
            `en échec : ${err.message}\nJournal :\n${journal.join("\n")}`,
        );
      }
      if (!label.startsWith("skip")) break;
    }
    journal.push(`${step}. ${label}`);

    await assertNumberingInvariants({
      adapter,
      organizationId,
      label: `[${adapter.label}] graine ${seed}, étape ${step}`,
      journal,
    });
  }

  return journal;
}
