/**
 * Script pour vérifier les données de réconciliation
 * Usage: node scripts/check-reconciliation-data.js
 */

import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config({ path: ".env.development" });

const MONGODB_URI = process.env.MONGODB_URI;

async function checkReconciliationData() {
  try {
    await mongoose.connect(MONGODB_URI);
    console.log("✅ Connecté à MongoDB\n");

    const db = mongoose.connection.db;

    // 1. Vérifier les transactions non rapprochées
    console.log("📊 TRANSACTIONS NON RAPPROCHÉES (crédit):");
    const transactions = await db
      .collection("transactions")
      .find({
        reconciliationStatus: { $in: ["unmatched", "suggested"] },
        amount: { $gt: 0 },
      })
      .toArray();

    if (transactions.length === 0) {
      console.log("  ❌ Aucune transaction non rapprochée trouvée");
    } else {
      for (const tx of transactions) {
        console.log(`  - ${tx.amount}€ | ${tx.description}`);
        console.log(
          `    workspaceId: ${tx.workspaceId} (type: ${typeof tx.workspaceId})`
        );
        console.log(`    status: ${tx.reconciliationStatus}`);
      }
    }

    // 2. Vérifier les factures en attente
    console.log("\n📄 FACTURES EN ATTENTE (PENDING):");
    const invoices = await db
      .collection("invoices")
      .find({
        status: "PENDING",
        linkedTransactionId: null,
      })
      .toArray();

    if (invoices.length === 0) {
      console.log("  ❌ Aucune facture en attente trouvée");
    } else {
      for (const inv of invoices) {
        const amount = inv.finalTotalTTC || inv.totalTTC;
        console.log(`  - ${amount}€ | Facture ${inv.number}`);
        console.log(
          `    workspaceId: ${inv.workspaceId} (type: ${typeof inv.workspaceId})`
        );
        console.log(
          `    client: ${inv.client?.name || inv.client?.firstName || "N/A"}`
        );
      }
    }

    // 3. Vérifier les correspondances potentielles
    console.log("\n🔍 CORRESPONDANCES POTENTIELLES:");
    for (const tx of transactions) {
      for (const inv of invoices) {
        const txWorkspace = tx.workspaceId?.toString();
        const invWorkspace = inv.workspaceId?.toString();
        const invoiceAmount = inv.finalTotalTTC || inv.totalTTC || 0;
        const tolerance = invoiceAmount * 0.01;
        const amountMatch = Math.abs(tx.amount - invoiceAmount) <= tolerance;
        const workspaceMatch = txWorkspace === invWorkspace;

        if (amountMatch) {
          console.log(
            `  ✅ MATCH MONTANT: Transaction ${tx.amount}€ ≈ Facture ${invoiceAmount}€`
          );
          console.log(`     Workspace match: ${workspaceMatch ? "✅" : "❌"}`);
          console.log(`     TX workspace: ${txWorkspace}`);
          console.log(`     INV workspace: ${invWorkspace}`);
        }
      }
    }

    // 4. Lister tous les workspaceIds uniques
    console.log("\n🏢 WORKSPACES UNIQUES:");
    const txWorkspaces = [
      ...new Set(transactions.map((t) => t.workspaceId?.toString())),
    ];
    const invWorkspaces = [
      ...new Set(invoices.map((i) => i.workspaceId?.toString())),
    ];
    console.log(`  Transactions: ${txWorkspaces.join(", ") || "aucun"}`);
    console.log(`  Factures: ${invWorkspaces.join(", ") || "aucun"}`);
  } catch (error) {
    console.error("❌ Erreur:", error);
  } finally {
    await mongoose.disconnect();
    console.log("\n🔌 Déconnecté de MongoDB");
  }
}

checkReconciliationData();
