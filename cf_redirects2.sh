#!/bin/bash
set -e

ZONE_ID="6d4c692b14b9c8d3b6926917eb56b624"
EMAIL="${CLOUDFLARE_JAY_ACCOUNT_EMAIL}"
KEY="${CLOUDFLARE_JAY_API_KEY}"

APPS=("socratic-trade" "codecaps" "hoghunter" "fleetlink" "dealdex" "usage-monitor" "botfleet" "personal-site")

for app in "${APPS[@]}"; do
    subdomain="${app}.simplewithus.com"
    echo "Creating DNS for ${subdomain}..."
    curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records" \
        -H "X-Auth-Email: ${EMAIL}" \
        -H "X-Auth-Key: ${KEY}" \
        -H "Content-Type: application/json" \
        -d "{\"type\":\"A\",\"name\":\"${subdomain}\",\"content\":\"192.0.2.1\",\"proxied\":true,\"ttl\":1}" | jq .
done

RULES_JSON="["
first=true
APPS_ALL=("congress-trade" "${APPS[@]}")
for app in "${APPS_ALL[@]}"; do
    if [ "$first" = true ]; then
        first=false
    else
        RULES_JSON="$RULES_JSON,"
    fi
    RULES_JSON="$RULES_JSON {
        \"action\": \"redirect\",
        \"action_parameters\": {
            \"from_value\": {
                \"status_code\": 301,
                \"target_url\": {
                    \"value\": \"https://simplewithus.com/${app}\"
                },
                \"preserve_query_string\": true
            }
        },
        \"expression\": \"(http.host eq \\\"${app}.simplewithus.com\\\")\",
        \"description\": \"Redirect ${app} subdomain to folder\",
        \"enabled\": true
    }"
done
RULES_JSON="$RULES_JSON]"

echo "Creating new ruleset..."
curl -s -X POST "https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/rulesets" \
    -H "X-Auth-Email: ${EMAIL}" \
    -H "X-Auth-Key: ${KEY}" \
    -H "Content-Type: application/json" \
    -d "{\"name\":\"SWU App Redirects\",\"kind\":\"zone\",\"phase\":\"http_request_dynamic_redirect\",\"rules\":${RULES_JSON}}" | jq .
