import os
import requests
import json

ZONE_ID = "6d4c692b14b9c8d3b6926917eb56b624"
EMAIL = os.environ.get("CLOUDFLARE_JAY_ACCOUNT_EMAIL")
KEY = os.environ.get("CLOUDFLARE_JAY_API_KEY")

HEADERS = {
    "X-Auth-Email": EMAIL,
    "X-Auth-Key": KEY,
    "Content-Type": "application/json"
}

APPS = [
    "congress-trade",
    "socratic-trade",
    "codecaps",
    "hoghunter",
    "fleetlink",
    "dealdex",
    "usage-monitor",
    "botfleet",
    "personal-site"
]

def ensure_dns(subdomain):
    name = f"{subdomain}.simplewithus.com"
    r = requests.get(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/dns_records?name={name}", headers=HEADERS)
    res = r.json()
    if not res.get("success"):
        print(f"Error for {name}:", res)
        return
    records = res.get("result", [])
    if len(records) > 0:
        record_id = records[0]["id"]
        # Update to proxied A record if needed
        if not records[0]["proxied"] or records[0]["type"] != "A":
            print(f"Updating DNS for {name}")
            requests.put(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/dns_records/{record_id}", headers=HEADERS, json={
                "type": "A",
                "name": name,
                "content": "192.0.2.1",
                "proxied": True,
                "ttl": 1
            })
        else:
            print(f"DNS {name} already correctly set")
    else:
        print(f"Creating DNS for {name}")
        requests.post(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/dns_records", headers=HEADERS, json={
            "type": "A",
            "name": name,
            "content": "192.0.2.1",
            "proxied": True,
            "ttl": 1
        })

for app in APPS:
    ensure_dns(app)

# Now manage the redirect ruleset
r = requests.get(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/rulesets", headers=HEADERS)
rulesets = r.json().get("result", [])
redirect_ruleset = next((rs for rs in rulesets if rs["phase"] == "http_request_dynamic_redirect"), None)

rules = []
for app in APPS:
    rules.append({
        "action": "redirect",
        "action_parameters": {
            "from_value": {
                "status_code": 301,
                "target_url": {
                    "value": f"https://simplewithus.com/{app}"
                },
                "preserve_query_string": True
            }
        },
        "expression": f'(http.host eq "{app}.simplewithus.com")',
        "description": f"Redirect {app} subdomain to folder",
        "enabled": True
    })

if redirect_ruleset:
    print("Updating existing redirect ruleset...")
    rs_id = redirect_ruleset["id"]
    
    # If the ruleset already has rules, we should append to them, or just replace them if we own it.
    # We will just replace them for now, assuming this is our ruleset.
    existing_rules = redirect_ruleset.get("rules", [])
    
    requests.put(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/rulesets/{rs_id}", headers=HEADERS, json={
        "rules": existing_rules + rules
    })
else:
    print("Creating new redirect ruleset...")
    requests.post(f"https://api.cloudflare.com/client/v4/zones/{ZONE_ID}/rulesets", headers=HEADERS, json={
        "name": "SWU App Redirects",
        "kind": "zone",
        "phase": "http_request_dynamic_redirect",
        "rules": rules
    })

print("Done!")
