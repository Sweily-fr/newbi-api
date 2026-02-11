// =============================================================================
// Script de migration : user.company → organization (flattened fields)
//
// Usage dans mongosh :
//   1. Se connecter : mongosh "mongodb://localhost:27017/newbi"
//      ou : mongosh "mongodb+srv://user:pass@cluster.mongodb.net/newbi"
//   2. Coller ce script et appuyer sur Entrée
//
// Le script :
//   - Lit les données de user.company.* pour chaque utilisateur
//   - Trouve l'organisation associée via la collection member
//   - Copie les champs manquants vers la collection organization (format aplati)
//   - Ne remplace JAMAIS une valeur existante dans organization
// =============================================================================

// ---- Configuration ----
const DRY_RUN = true; // Mettre à false pour appliquer les modifications

print("==============================================================");
print("  MIGRATION : user.company → organization (champs aplatis)");
print("  MODE : " + (DRY_RUN ? "SIMULATION (dry-run)" : "ÉCRITURE RÉELLE"));
print("==============================================================\n");

// ---- Compteurs ----
let totalUsers = 0;
let usersWithCompany = 0;
let usersWithOrg = 0;
let orgsUpdated = 0;
let orgsSkipped = 0;
let errors = 0;

// ---- Récupérer tous les utilisateurs avec des données company ----
const users = db.user.find({
  $or: [
    { "company.name": { $exists: true, $ne: null, $ne: "" } },
    { "company.siret": { $exists: true, $ne: null, $ne: "" } },
    { "company.email": { $exists: true, $ne: null, $ne: "" } },
    { "company.address": { $exists: true } },
    { "company.bankDetails": { $exists: true } },
  ]
}).toArray();

totalUsers = db.user.countDocuments();
usersWithCompany = users.length;

print(`📊 Total utilisateurs en base : ${totalUsers}`);
print(`📊 Utilisateurs avec données company : ${usersWithCompany}\n`);

if (usersWithCompany === 0) {
  print("✅ Aucun utilisateur avec des données company à migrer.");
  print("   Tous les utilisateurs utilisent déjà le nouveau format organization.");
} else {

  // ---- Traiter chaque utilisateur ----
  users.forEach(function(user) {
    const userId = user._id.toString();
    const email = user.email || "inconnu";
    const company = user.company || {};
    const address = company.address || {};
    const bankDetails = company.bankDetails || {};

    print(`\n👤 ${email} (${userId})`);

    // Trouver le membership de cet utilisateur
    const membership = db.member.findOne({ userId: userId });
    if (!membership) {
      print(`   ⚠️  Pas de membership trouvé → ignoré`);
      orgsSkipped++;
      return;
    }

    const orgId = membership.organizationId;

    // Trouver l'organisation (Better Auth utilise un champ "id" string, pas "_id")
    let org = db.organization.findOne({ id: orgId });
    if (!org) {
      // Essayer aussi avec _id directement
      try {
        org = db.organization.findOne({ _id: orgId });
      } catch(e) {}
    }
    if (!org) {
      print(`   ❌ Organisation ${orgId} introuvable → ignoré`);
      errors++;
      return;
    }

    usersWithOrg++;
    print(`   🏢 Organisation : ${org.name || org.companyName || orgId}`);

    // ---- Construire les mises à jour (seulement les champs manquants) ----
    const updates = {};

    function setIfMissing(orgField, value) {
      if (value && value !== "" && (org[orgField] === undefined || org[orgField] === null || org[orgField] === "")) {
        updates[orgField] = value;
      }
    }

    // Informations de base
    setIfMissing("companyName", company.name);
    setIfMissing("companyEmail", company.email);
    setIfMissing("companyPhone", company.phone);
    setIfMissing("website", company.website);
    setIfMissing("logo", company.logo);

    // Informations légales
    setIfMissing("siret", company.siret);
    // Dériver le SIREN depuis le SIRET (9 premiers chiffres)
    if (company.siret && company.siret.length >= 9) {
      setIfMissing("siren", company.siret.substring(0, 9));
    }
    setIfMissing("vatNumber", company.vatNumber);
    setIfMissing("rcs", company.rcs);
    setIfMissing("legalForm", company.companyStatus);
    setIfMissing("capitalSocial", company.capitalSocial);

    // Adresse (aplatie)
    setIfMissing("addressStreet", address.street);
    setIfMissing("addressCity", address.city);
    setIfMissing("addressZipCode", address.postalCode);
    setIfMissing("addressCountry", address.country);

    // Coordonnées bancaires (aplaties)
    setIfMissing("bankName", bankDetails.bankName);
    setIfMissing("bankIban", bankDetails.iban);
    setIfMissing("bankBic", bankDetails.bic);

    // ---- Appliquer les mises à jour ----
    const fieldCount = Object.keys(updates).length;

    if (fieldCount === 0) {
      print(`   ✅ Organisation déjà à jour (tous les champs remplis)`);
      orgsSkipped++;
    } else {
      const fieldNames = Object.keys(updates).join(", ");
      print(`   📝 ${fieldCount} champ(s) à migrer : ${fieldNames}`);

      if (!DRY_RUN) {
        try {
          const result = db.organization.updateOne(
            { _id: org._id },
            { $set: updates }
          );
          if (result.modifiedCount > 0) {
            print(`   ✅ Organisation mise à jour avec succès`);
            orgsUpdated++;
          } else {
            print(`   ⚠️  Aucune modification appliquée`);
            orgsSkipped++;
          }
        } catch(e) {
          print(`   ❌ Erreur : ${e.message}`);
          errors++;
        }
      } else {
        print(`   🧪 [SIMULATION] Serait mis à jour :`);
        Object.keys(updates).forEach(function(key) {
          const val = typeof updates[key] === "string" && updates[key].length > 50
            ? updates[key].substring(0, 50) + "..."
            : updates[key];
          print(`      ${key} = ${JSON.stringify(val)}`);
        });
        orgsUpdated++;
      }
    }
  });

}

// ---- Résumé ----
print("\n==============================================================");
print("  RÉSUMÉ DE LA MIGRATION");
print("==============================================================");
print(`  Total utilisateurs           : ${totalUsers}`);
print(`  Avec données company         : ${usersWithCompany}`);
print(`  Avec organisation trouvée    : ${usersWithOrg}`);
print(`  Organisations mises à jour   : ${orgsUpdated}`);
print(`  Organisations déjà à jour    : ${orgsSkipped}`);
print(`  Erreurs                       : ${errors}`);
print("==============================================================");

if (DRY_RUN) {
  print("\n🧪 MODE SIMULATION — aucune modification effectuée.");
  print("   Pour appliquer, changez DRY_RUN = false en haut du script.\n");
} else {
  print("\n✅ MIGRATION TERMINÉE.\n");
}
