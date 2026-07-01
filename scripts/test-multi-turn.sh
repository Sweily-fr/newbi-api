#!/usr/bin/env bash
#
# Test bout-en-bout du multi-turn (V1 Étape 7.2).
#
# Scénario validé par le user :
#   Tour 1 : "CA ce mois"
#     → done event renvoie un conversationId
#     → tool_use attendu : get_revenue(this_month)
#
#   Tour 2 (même conversationId) : "et le mois d'avant ?"
#     → le LLM doit comprendre qu'on parle toujours de CA
#     → tool_use attendu : get_revenue(last_month) — pas autre chose
#     → AUCUNE question "le CA de quoi ?"
#
#   Tour 3 (même conversationId) : question qui mentionne un client
#     → vérifie la stabilité du pseudoMap à travers les tours
#
# Pré-requis :
#   - newbi-api lancé sur localhost:4000 (npm run dev)
#   - Variables d'env à fournir :
#       JWT=<bearer token valide>
#       WS=<workspace id>
#   - Récupérer JWT depuis l'app mobile : se connecter, puis dans une
#     requête réseau (DevTools) copier le header Authorization.
#
# Usage :
#   JWT=eyJ... WS=68a... bash scripts/test-multi-turn.sh

set -euo pipefail

API="${API:-http://localhost:4000}"
JWT="${JWT:?Définir JWT=<bearer token>}"
WS="${WS:?Définir WS=<workspace id>}"

# Couleurs (terminal mac)
B="\033[1m"; G="\033[32m"; Y="\033[33m"; R="\033[31m"; D="\033[2m"; N="\033[0m"

call() {
  local turn="$1" body="$2"
  echo
  echo -e "${B}──── Tour $turn ────${N}"
  echo -e "${D}body: $body${N}"
  echo
  # Stream complet capturé (curl -N = no buffer)
  local out
  out=$(curl -sN -X POST "$API/api/assistant/chat/stream" \
    -H "Content-Type: application/json" \
    -H "Authorization: Bearer $JWT" \
    -H "x-workspace-id: $WS" \
    -d "$body")
  # Affichage des events nommés
  echo "$out" | awk '
    /^event: meta$/        { getline d; sub(/^data: /, "", d); print "  [meta]      " d; next }
    /^event: tool_use$/    { getline d; sub(/^data: /, "", d); print "  [tool_use]  " d; next }
    /^event: text$/        { getline d; sub(/^data: /, "", d); printf "%s", d; next }
    /^event: done$/        { getline d; sub(/^data: /, "", d); print "\n  [done]      " d; next }
    /^event: error$/       { getline d; sub(/^data: /, "", d); print "  [error]     " d; next }
  ' | sed 's/{"delta":"\([^"]*\)"}/\1/g'
  echo "$out" >/tmp/last-sse-output.txt
}

# Extraction du conversationId depuis le dernier event "done"
extract_conv_id() {
  awk '/^event: done$/ { getline d; print d; exit }' /tmp/last-sse-output.txt \
    | sed -n 's/.*"conversationId":"\([^"]*\)".*/\1/p'
}

# Extraction du nom du 1er tool appelé (depuis l'event tool_use)
extract_tool_name() {
  awk '/^event: tool_use$/ { getline d; print d; exit }' /tmp/last-sse-output.txt \
    | sed -n 's/.*"name":"\([^"]*\)".*/\1/p'
}

# ─── Tour 1 : nouvelle conversation ───────────────────────────────
call 1 '{"message":"CA ce mois"}'
CONV_ID=$(extract_conv_id)
TOOL_1=$(extract_tool_name)
echo
echo -e "${Y}→ conversationId capturé : $CONV_ID${N}"
echo -e "${Y}→ tool appelé tour 1     : $TOOL_1 (attendu : get_revenue)${N}"

[ -z "$CONV_ID" ] && { echo -e "${R}❌ conversationId vide${N}"; exit 1; }

# ─── Tour 2 : RELANCE — test contextuel ───────────────────────────
call 2 "{\"conversationId\":\"$CONV_ID\",\"message\":\"et le mois d'avant ?\"}"
TOOL_2=$(extract_tool_name)
echo
echo -e "${Y}→ tool appelé tour 2     : $TOOL_2 (attendu : get_revenue, period:last_month)${N}"

if [ "$TOOL_2" = "get_revenue" ]; then
  echo -e "${G}✅ MULTI-TURN OPÉRATIONNEL — le LLM a compris le contexte${N}"
else
  echo -e "${R}❌ Le tool appelé n'est pas get_revenue (mais : $TOOL_2)${N}"
  echo -e "${R}   → le contexte ne passe pas, à creuser AVANT le fil front${N}"
fi

# ─── Tour 3 : mention d'un client (test stabilité pseudoMap) ──────
call 3 "{\"conversationId\":\"$CONV_ID\",\"message\":\"qui m'a le plus payé ce mois ?\"}"
TOOL_3=$(extract_tool_name)
echo
echo -e "${Y}→ tool appelé tour 3     : $TOOL_3 (attendu : get_top_clients)${N}"

# Tour 4 : on rejoue la même question — les Client_N persistés doivent
# être réutilisés (pas de Client_X qui change d'une fois sur l'autre).
call 4 "{\"conversationId\":\"$CONV_ID\",\"message\":\"et c'est qui le numéro 1 ?\"}"

echo
echo -e "${B}──── Inspection finale via GET /conversations/$CONV_ID ────${N}"
curl -sf -H "Authorization: Bearer $JWT" -H "x-workspace-id: $WS" \
  "$API/api/assistant/conversations/$CONV_ID" \
  | python3 -m json.tool 2>/dev/null || cat /tmp/last-sse-output.txt
