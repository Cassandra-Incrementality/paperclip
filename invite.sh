#!/bin/bash
# Generate a Paperclip team invite link
# Usage: ./invite.sh

API="http://127.0.0.1:3100"
COMPANY_ID="c19d22c4-0650-4862-889b-9a88be3b5668"

# Login
COOKIE=$(curl -s -c - -X POST "$API/api/auth/sign-in/email" \
  -H "Content-Type: application/json" \
  -d '{"email":"gabriele@cassandra.app","password":"PaperclipAdmin2026!"}' 2>&1 | grep "session_token" | awk '{print $NF}')

if [ -z "$COOKIE" ]; then
  echo "Error: Could not login. Is the server running?"
  exit 1
fi

# Create invite
RESULT=$(curl -s -X POST "$API/api/companies/$COMPANY_ID/invites" \
  -H "Cookie: __Secure-better-auth.session_token=$COOKIE" \
  -H "Content-Type: application/json" \
  -H "Origin: $API" \
  -d '{"allowedJoinTypes":"human"}')

TOKEN=$(echo "$RESULT" | python3 -c "import json,sys; print(json.load(sys.stdin).get('token',''))" 2>/dev/null)

if [ -z "$TOKEN" ]; then
  echo "Error: Could not create invite."
  echo "$RESULT"
  exit 1
fi

echo ""
echo "Team invite link (expires in 10 min):"
echo ""
echo "  https://paperclip.cassandragroup.cc/invite/$TOKEN"
echo ""
