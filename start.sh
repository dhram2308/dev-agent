#!/bin/bash
# ============================================================
#  start.sh  —  one-shot setup + run for $TICKET
#
#  HOW TO USE:
#  1. Fill in the 5 values in the FILL IN block below
#  2. chmod +x start.sh
#  3. ./start.sh
# ============================================================

# ── FILL IN THESE 5 VALUES ───────────────────────────────────
ANTHROPIC_API_KEY=""          # console.anthropic.com/keys
JIRA_TOKEN=""                 # id.atlassian.com → security → api tokens (NEW one)
JIRA_EMAIL="yogendra@mastersindia.co"
GITLAB_TOKEN=""               # http://10.200.11.32/-/profile/personal_access_tokens
SLACK_WEBHOOK=""              # api.slack.com/apps → incoming webhooks
# ─────────────────────────────────────────────────────────────

# colours
R="\033[31m" G="\033[32m" Y="\033[33m" B="\033[34m" W="\033[0m" BOLD="\033[1m"

echo ""
# ── Ticket ID ──────────────────────────────────────────────────
if [ -z "$TICKET" ]; then
  read -p "  Jira ticket ID (e.g. AUT-1234): " TICKET
fi
if [ -z "$TICKET" ]; then
  echo -e "${R}  ✗ TICKET not set${W}"
  exit 1
fi
TICKET=$(echo "$TICKET" | tr '[:lower:]' '[:upper:]')
export TICKET

echo -e "${BOLD}${B}  AI Dev Agent — ${TICKET} setup${W}"
echo -e "${B}  ─────────────────────────────────────────${W}"

# validate filled in
MISSING=0
[ -z "$ANTHROPIC_API_KEY" ] && echo -e "${R}  ✗ ANTHROPIC_API_KEY not set${W}" && MISSING=1
[ -z "$JIRA_TOKEN" ]        && echo -e "${R}  ✗ JIRA_TOKEN not set${W}"         && MISSING=1
[ -z "$GITLAB_TOKEN" ]      && echo -e "${R}  ✗ GITLAB_TOKEN not set${W}"       && MISSING=1
[ -z "$SLACK_WEBHOOK" ]     && echo -e "${R}  ✗ SLACK_WEBHOOK not set${W}"      && MISSING=1
[ $MISSING -eq 1 ] && echo -e "\n${R}  Fill in the values above and re-run.${W}\n" && exit 1

# ── Step 1: Node.js check ────────────────────────────────────
echo -e "\n  Checking Node.js..."
if ! command -v node &>/dev/null; then
  echo -e "${R}  ✗ Node.js not found.${W}"
  echo -e "  Install from ${Y}https://nodejs.org${W} then re-run this script."
  exit 1
fi
NODE_VER=$(node --version)
echo -e "${G}  ✓ Node.js ${NODE_VER}${W}"

# ── Step 2: Install dependencies ─────────────────────────────
echo -e "\n  Installing dependencies..."
[ ! -f package.json ] && npm init -y --silent
npm install @anthropic-ai/sdk --silent
echo -e "${G}  ✓ @anthropic-ai/sdk installed${W}"

# ── Step 3: Fetch your Jira account ID ───────────────────────
echo -e "\n  Fetching Jira account IDs..."
JIRA_AUTH=$(echo -n "${JIRA_EMAIL}:${JIRA_TOKEN}" | base64)

OWNER_JIRA_ID=$(curl -sf \
  -H "Authorization: Basic ${JIRA_AUTH}" \
  -H "Content-Type: application/json" \
  "https://mastersindia-sols.atlassian.net/rest/api/3/myself" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).accountId)}catch{console.log('ERROR')}})")

if [ "$OWNER_JIRA_ID" = "ERROR" ] || [ -z "$OWNER_JIRA_ID" ]; then
  echo -e "${R}  ✗ Could not fetch your Jira ID — check JIRA_TOKEN and JIRA_EMAIL${W}"
  exit 1
fi
echo -e "${G}  ✓ Your Jira ID   : ${OWNER_JIRA_ID}${W}"

# ── Step 4: Fetch QA's Jira account ID ───────────────────
QA_JIRA_ID=$(curl -sf \
  -H "Authorization: Basic ${JIRA_AUTH}" \
  -H "Content-Type: application/json" \
  "https://mastersindia-sols.atlassian.net/rest/api/3/user/search?query=anshit" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r[0]?.accountId||'NOT_FOUND')}catch{console.log('ERROR')}})")

if [ "$QA_JIRA_ID" = "NOT_FOUND" ] || [ "$QA_JIRA_ID" = "ERROR" ] || [ -z "$QA_JIRA_ID" ]; then
  echo -e "${Y}  ⚠ QA's Jira ID not found — searching by display name...${W}"
  QA_JIRA_ID=$(curl -sf \
    -H "Authorization: Basic ${JIRA_AUTH}" \
    "https://mastersindia-sols.atlassian.net/rest/api/3/user/search?query=malhotra" \
    | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{const r=JSON.parse(d);console.log(r[0]?.accountId||'NOT_FOUND')}catch{console.log('NOT_FOUND')}})")
fi

if [ "$QA_JIRA_ID" = "NOT_FOUND" ] || [ -z "$QA_JIRA_ID" ]; then
  echo -e "${Y}  ⚠ Could not auto-find QA's ID. Set QA_JIRA_ID manually in .env later.${W}"
  QA_JIRA_ID="FILL_MANUALLY"
else
  echo -e "${G}  ✓ QA Jira ID : ${QA_JIRA_ID}${W}"
fi

# ── Step 5: Fetch GitLab project ID ──────────────────────────
echo -e "\n  Fetching GitLab project ID..."
GITLAB_PROJECT_ID=$(curl -sf \
  -H "PRIVATE-TOKEN: ${GITLAB_TOKEN}" \
  "http://10.200.11.32/api/v4/projects/mastersindia%2Fmi_frontend_apps" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).id)}catch{console.log('ERROR')}})")

if [ "$GITLAB_PROJECT_ID" = "ERROR" ] || [ -z "$GITLAB_PROJECT_ID" ]; then
  echo -e "${R}  ✗ Could not fetch GitLab project ID — check GITLAB_TOKEN${W}"
  exit 1
fi
echo -e "${G}  ✓ GitLab project ID : ${GITLAB_PROJECT_ID}${W}"

# ── Step 6: Verify Jira ticket $TICKET ──────────────────────
echo -e "\n  Verifying ticket $TICKET..."
TICKET_TITLE=$(curl -sf \
  -H "Authorization: Basic ${JIRA_AUTH}" \
  -H "Content-Type: application/json" \
  "https://mastersindia-sols.atlassian.net/rest/api/3/issue/$TICKET" \
  | node -e "let d='';process.stdin.on('data',c=>d+=c).on('end',()=>{try{console.log(JSON.parse(d).fields?.summary||'unknown')}catch{console.log('ERROR')}})")

if [ "$TICKET_TITLE" = "ERROR" ] || [ -z "$TICKET_TITLE" ]; then
  echo -e "${R}  ✗ Could not fetch $TICKET — check Jira access${W}"
  exit 1
fi
echo -e "${G}  ✓ Ticket : ${TICKET_TITLE}${W}"

# ── Step 7: Get Slack member IDs ─────────────────────────────
echo -e "\n  ${Y}Action needed: get Slack member IDs${W}"
echo -e "  1. Open Slack → click your avatar → View Profile → ··· → Copy Member ID"
echo -e "  2. Search QA → click his profile → ··· → Copy Member ID"
echo ""
read -p "  Your Slack member ID (e.g. U0123ABCD): " OWNER_SLACK_ID
read -p "  QA Slack member ID                : " QA_SLACK_ID

# ── Step 8: Write .env ───────────────────────────────────────
echo -e "\n  Writing .env..."
cat > .env << EOF
ANTHROPIC_API_KEY=${ANTHROPIC_API_KEY}
JIRA_TOKEN=${JIRA_TOKEN}
JIRA_EMAIL=${JIRA_EMAIL}
GITLAB_TOKEN=${GITLAB_TOKEN}
GITLAB_PROJECT_ID=${GITLAB_PROJECT_ID}
OWNER_JIRA_ID=${OWNER_JIRA_ID}
QA_JIRA_ID=${QA_JIRA_ID}
OWNER_SLACK_ID=${OWNER_SLACK_ID}
QA_SLACK_ID=${QA_SLACK_ID}
SLACK_WEBHOOK=${SLACK_WEBHOOK}
EOF
echo -e "${G}  ✓ .env written${W}"

# ── Step 9: Confirm run-agent.js exists ──────────────────────
if [ ! -f "run-agent.js" ]; then
  echo -e "\n${R}  ✗ run-agent.js not found in current folder.${W}"
  echo -e "  Copy run-agent.js from the chat into: $(pwd)/run-agent.js"
  echo -e "  Then run:  export \$(cat .env | xargs) && node run-agent.js\n"
  exit 1
fi

# ── Step 10: Run ─────────────────────────────────────────────
echo -e "\n${BOLD}${G}  ─────────────────────────────────────────${W}"
echo -e "${BOLD}${G}  All set. Starting agent for $TICKET...${W}"
echo -e "${BOLD}${G}  ─────────────────────────────────────────${W}\n"
echo -e "  State is saved to ${Y}state-$TICKET.json${W}"
echo -e "  If it stops, re-run to resume from last stage.\n"

export $(cat .env | xargs 2>/dev/null)
node run-agent.js