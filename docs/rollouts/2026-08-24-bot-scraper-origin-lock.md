# Bot and scraper protection: production origin lock

## Summary

Enabled the existing `SCRAPE_GUARD_ENABLED=true` control in the Congress.Trade production Infisical project.  This activates the application-level user-agent blocklist, public API request budget, daily served-row budget, and public API `X-Robots-Tag: noindex` behavior.

The production origin IP was also directly reachable on HTTP and HTTPS, bypassing Cloudflare WAF, browser checks, rate controls, and admin edge protection.  The host firewall was corrected at Docker's `DOCKER-USER` chain, which is the enforcement point for Docker-published ports, allowing ports 80/443 only from Cloudflare's published IPv4 and IPv6 ranges and dropping other traffic.  The rules were saved with `iptables-persistent` / `netfilter-persistent` for reboot persistence.

## Files changed

- Production Infisical: `SCRAPE_GUARD_ENABLED=true` in the CT app project, `prod`, `/`.
- Production host: persistent IPv4 and IPv6 `DOCKER-USER` rules for ports 80/443.
- Production host: `ufw` was removed as a package dependency when `iptables-persistent` was installed; `netfilter-persistent` is now the active persistent firewall service.

## Verification

- `https://congress.trade/` → HTTP 200 through Cloudflare.
- `curl` user-agent on `/api/transactions` → HTTP 403.
- Browser user-agent on `/api/transactions` → HTTP 200.
- Direct origin HTTP and HTTPS to `167.233.254.55` → connection timeout.
- SSH management remained reachable.
- `netfilter-persistent` is active and the IPv4/IPv6 Docker origin-lock rules are present.

## Turnstile decision

Turnstile is not present in the repository or deployed application.  It is not appropriate as a blanket gate for the public feed because that would obstruct browser, iOS, RSS, and legitimate research access while still not stopping a determined scraper with a real browser.  Keep the skill available for a future targeted gate on high-abuse mutations such as account, magic-link, or subscription creation if Cloudflare telemetry shows that need; no widget or siteverify worker is currently required.

## Follow-ups

- Add monitoring that alerts if `SCRAPE_GUARD_ENABLED` becomes missing or false in production.
- Re-check the Docker firewall rules after any host networking, Docker, or Cloudflare range change.
- Consider Cloudflare Pro/Bot Management or targeted Cloudflare rate-limit rules if the public feed becomes an abuse target; Free-plan browser checks are not a substitute for origin locking.
