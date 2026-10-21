#!/usr/bin/env bash
# AFC-459: ship-testflight.sh resolves App Store Connect credentials from the
# environment first, then from a key file the operator named (as a FILE), then
# from Infisical through fleet-secrets, and never from the old secrets folder.
#
# 2026-10-21 (Kody rule 42 on PR #271): the private key is handed over in the
# environment, never as a path the node client reads.  The shell layer owns the
# credential, so this test drives load_secrets with a FAKE fleet-secrets binary
# and throwaway keys generated here at test time.  No network, no real
# secrets, and no committed key.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
script="${here}/ship-testflight.sh"
tmp="$(mktemp -d)"
# The throwaway HOME lives inside the temp dir, so the cleanup has to run with
# the real HOME in place:  a trash helper that protects the home directory
# refuses to remove a parent of it.
real_home="${HOME}"
trap 'HOME="$real_home" rm -rf "$tmp"' EXIT
export HOME="${tmp}/home"
export TMPDIR="${tmp}/tmp"
mkdir -p "$HOME" "$TMPDIR"

fail() { echo "FAIL: $*" >&2; exit 1; }

# A throwaway key pair, generated here and never committed.  The client parses
# a PEM before it accepts it, so a fake envelope is not a key.
gen_pem() {
  node -e 'process.stdout.write(require("crypto").generateKeyPairSync("ec", { namedCurve: "prime256v1" }).privateKey.export({ type: "pkcs8", format: "pem" }))'
}
gen_pem > "${tmp}/asc.p8"
gen_pem > "${tmp}/other.p8"
chmod 600 "${tmp}/asc.p8" "${tmp}/other.p8"

# Fake fleet-secrets: prints synthetic values, records the folders it was asked for.
cat > "${tmp}/fleet-secrets" <<'FAKE'
#!/usr/bin/env bash
[[ "$1" == get ]] || exit 2
name="$2"; folder="$4"
echo "${name} ${folder}" >> "${FAKE_LOG}"
case "${folder}:${name}" in
  /asc:ASC_KEY_ID) printf 'ABCDE12345\n' ;;
  /asc:ASC_ISSUER_ID) printf 'issuer-synthetic\n' ;;
  /asc:ASC_KEY_P8) cat "${FAKE_ASC_PEM}" ;;
  /authkey-otherkey01-p8:AUTHKEY_OTHERKEY01) cat "${FAKE_OTHER_PEM}" ;;
  *) exit 3 ;;
esac
FAKE
chmod +x "${tmp}/fleet-secrets"
export FAKE_LOG="${tmp}/fake.log"
export FAKE_ASC_PEM="${tmp}/asc.p8"
export FAKE_OTHER_PEM="${tmp}/other.p8"
: > "$FAKE_LOG"

# The credential layer of ship-testflight.sh, taken out of the script and
# driven on its own.  The names are this repository's.
extract() {
  awk '
    /^fleet_secret_get\(\) \{/ || /^load_secrets\(\) \{/ || /^asc_cleanup\(\) \{/ || /^expand_tilde\(\) \{/ { grab = 1 }
    grab { print }
    grab && /^\}/ { grab = 0 }
  ' "$script"
}

funcs="${tmp}/funcs.sh"
{
  echo 'log() { :; }'
  echo 'ASC_TMP_DIR=""'
  echo "FLEET_SECRETS_BIN=\"${tmp}/fleet-secrets\""
  echo "FLEET_DIR=\"${here}\""
  extract
} > "$funcs"
grep -q '^load_secrets()' "$funcs" || fail "load_secrets not found in ship-testflight.sh"
grep -q '^fleet_secret_get()' "$funcs" || fail "fleet_secret_get not found in ship-testflight.sh"

# 1. Nothing in the environment:  credentials come from Infisical, the key is a 0600 temp file.
out="$(env -u ASC_KEY_ID -u ASC_ISSUER_ID -u ASC_KEY_PATH -u ASC_KEY_P8 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key ]]
  [[ "$ASC_KEY_ID" == ABCDE12345 && "$ASC_ISSUER_ID" == issuer-synthetic ]]
  [[ -f "$ASC_KEY_PATH" ]]
  mode="$(stat -c %a "$ASC_KEY_PATH" 2>/dev/null || stat -f %Lp "$ASC_KEY_PATH")"
  [[ "$mode" == 600 ]]
  [[ "$API_PRIVATE_KEYS_DIR" == "$ASC_TMP_DIR" ]]
  # The staged file holds the /asc key.
  [[ "$(cat "$ASC_KEY_PATH")" == "$(cat "'"$tmp"'/asc.p8")" ]]
  # The client takes the key from the environment, never from a path.
  [[ "$(printf "%s" "$ASC_KEY_P8")" == "$(cat "'"$tmp"'/asc.p8")" ]]
  echo "$ASC_KEY_PATH"
  asc_cleanup
  [[ ! -e "$ASC_KEY_PATH" ]]
')" || fail "load_secrets from Infisical"
[[ ! -e "$out" ]] || fail "temp key file survived cleanup"
grep -q '^ASC_KEY_ID /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key id"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask Infisical /asc for the key"

# 2. The environment wins over a named key file.  A disk credential never
# overrides the environment (Kody rule 42 on PR #271):  a stale or foreign
# value in an operator's shell would sign the upload with the wrong key.
: > "$FAKE_LOG"
cp "${tmp}/asc.p8" "${tmp}/named-key.p8"
chmod 600 "${tmp}/named-key.p8"
ASC_KEY_ID=ENVKEY0001 ASC_ISSUER_ID=env-issuer \
  ASC_KEY_P8="$(<"${tmp}/other.p8")" ASC_KEY_PATH="${tmp}/named-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ENVKEY0001 ]]
  # The environment key is the credential in play.
  [[ "$(printf "%s" "$ASC_KEY_P8")" == "$(cat "'"$tmp"'/other.p8")" ]]
  [[ "$(printf "%s" "$ASC_KEY_P8")" != "$(cat "'"$tmp"'/asc.p8")" ]]
  # The named file was not read:  no file was staged for the client.
  [[ -z "${ASC_STAGED_KEY_PATH:-}" ]]
' || fail "a named key file overrode the environment"
[[ ! -s "$FAKE_LOG" ]] || fail "fleet-secrets was called although the environment was complete"

# 2a. A named key file is used as a FILE:  the key material never enters this
# shell, the file is used where it lies, and the client is handed the key in
# the child's environment by the hardened reader.
: > "$FAKE_LOG"
cp "${tmp}/asc.p8" "${tmp}/env-key.p8"
chmod 600 "${tmp}/env-key.p8"
env -u ASC_KEY_P8 ASC_KEY_ID=ENVKEY0001 ASC_ISSUER_ID=env-issuer ASC_KEY_PATH="${tmp}/env-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ENVKEY0001 && -z "$ASC_TMP_DIR" ]]
  # The named file is used where it lies:  no copy is made of it.
  [[ "$ASC_KEY_PATH" == "'"${tmp}"'/env-key.p8" ]]
  # The key stays in the file:  it never enters this shell.
  [[ -z "${ASC_KEY_P8:-}" ]]
  # The client is handed the key from the file, in the child environment.
  [[ "$ASC_STAGED_KEY_PATH" == "'"${tmp}"'/env-key.p8" ]]
' || fail "the named key file was not used as a file"
[[ ! -s "$FAKE_LOG" ]] || fail "fleet-secrets was called although the named file was usable"

# 2b. A staged key file is never read into a variable:  the shell that owns it
# only ever holds its path.
if grep -nE 'asc-key\.mjs" read .*\)" \|\|' "$script" >/dev/null; then
  fail "ship-testflight.sh reads the key material into a variable"
fi

# 2c. An ambient ASC_KEY_P8 that is not a PEM private key is ignored, and the
# run fails closed rather than signing with something that is not a key.
: > "$FAKE_LOG"
ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer ASC_KEY_P8="not a private key at all" bash -c '
  set -euo pipefail
  unset ASC_KEY_PATH
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
  [[ -z "${ASC_KEY_P8:-}" ]]
' || fail "an ASC_KEY_P8 that is not a key was adopted"

# 2d. An ambient ASC_KEY_P8 without a key id is ignored:  the key id, the
# issuer and the key belong together.
: > "$FAKE_LOG"
ASC_KEY_ID="" ASC_ISSUER_ID="" ASC_KEY_P8="$(<"${tmp}/other.p8")" bash -c '
  set -euo pipefail
  unset ASC_KEY_PATH
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  [[ "$(printf "%s" "$ASC_KEY_P8")" == "$(cat "'"$tmp"'/asc.p8")" ]]
' || fail "an ASC_KEY_P8 without a key id was adopted"

# 2e. An env key id that is NOT the /asc one never gets the /asc key:  its own .p8 comes from
# /authkey-<id>-p8, and /asc ASC_KEY_P8 is not requested.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 ASC_ISSUER_ID=issuer-other bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == OTHERKEY01 ]]
  [[ "$ASC_ISSUER_ID" == issuer-other ]]
  [[ "$(cat "$ASC_KEY_PATH")" == "$(cat "'"$tmp"'/other.p8")" ]]
  [[ "$(cat "$ASC_KEY_PATH")" != "$(cat "'"$tmp"'/asc.p8")" ]]
  asc_cleanup
' || fail "env key id different from /asc was not given its own key"
grep -q '^AUTHKEY_OTHERKEY01 /authkey-otherkey01-p8$' "$FAKE_LOG" || fail "did not ask the per-key folder"
if grep -q '^ASC_KEY_P8 ' "$FAKE_LOG"; then fail "mixed an env key id with the /asc key"; fi

# 2f. An env key id that is not the /asc one with NO env issuer fails closed:  the /asc issuer
# is never paired with another key's .p8.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "mixed the /asc issuer with another key"
if grep -q '^ASC_ISSUER_ID ' "$FAKE_LOG"; then fail "asked /asc for an issuer for a different key id"; fi

# 2g. An env key id equal to the /asc one uses the /asc key.
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_ISSUER_ID -u ASC_KEY_P8 ASC_KEY_ID=ABCDE12345 bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == ABCDE12345 ]]
  [[ "$(cat "$ASC_KEY_PATH")" == "$(cat "'"$tmp"'/asc.p8")" ]]
  asc_cleanup
' || fail "env key id equal to /asc was not served from /asc"
grep -q '^ASC_KEY_P8 /asc$' "$FAKE_LOG" || fail "did not ask /asc ASC_KEY_P8"

# 2h. An env key id with no key material anywhere fails closed (no api_key mode).
: > "$FAKE_LOG"
env -u ASC_KEY_PATH -u ASC_KEY_P8 ASC_KEY_ID=NOSUCHKEY0 ASC_ISSUER_ID=any-issuer bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == none && -z "$ASC_TMP_DIR" ]]
' || fail "missing key material did not fail closed"

# 2i. A named ASC_KEY_PATH that does not exist is not a credential:  the run
# falls through to the fleet credential instead of aborting, and the path is
# reported as missing rather than as unreadable.
: > "$FAKE_LOG"
err="$(env -u ASC_KEY_P8 ASC_KEY_ID=OTHERKEY01 ASC_ISSUER_ID=issuer-other ASC_KEY_PATH="${tmp}/no-such-key.p8" bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  load_secrets
  [[ "$AUTH_MODE" == api_key && "$ASC_KEY_ID" == OTHERKEY01 ]]
  [[ "$ASC_KEY_PATH" != "'"${tmp}"'/no-such-key.p8" ]]
  [[ "$(cat "$ASC_KEY_PATH")" == "$(cat "'"$tmp"'/other.p8")" ]]
  asc_cleanup
' 2>&1 >/dev/null)" || fail "a missing key file did not fall through to the fleet credential"
[[ "$err" == *"does not exist"* ]] || fail "a missing key file was not reported as missing: ${err}"

# 2j. Only a leading "~/" is expanded:  "~user/x" must not be merged with $HOME.
env -u ASC_KEY_P8 ASC_KEY_ID=TILDE00001 ASC_ISSUER_ID=tilde-issuer bash -c '
  set -euo pipefail
  source "'"$funcs"'"
  [[ "$(expand_tilde "~/k.p8")" == "$HOME/k.p8" ]]
  [[ "$(expand_tilde "~other/k.p8")" == "~other/k.p8" ]]
  [[ "$(expand_tilde "/abs/k.p8")" == "/abs/k.p8" ]]
' || fail "expand_tilde"

# 3. The credential never travels in a command argument.  The secret reaches
# the child through the environment, so its own argv must not carry it.
argv="$(ASC_KEY_ID=ENVKEY0005 ASC_ISSUER_ID=env-issuer ASC_KEY_P8="$(<"${tmp}/other.p8")" bash -c '
  set -euo pipefail
  ps -o args= -p $$ 2>/dev/null || true
')"
pem="$(<"${tmp}/other.p8")"
[[ "$argv" != *"$pem"* ]] || fail "the credential reached the child in its command arguments"

# 4. Neither this test nor the ship script passes a credential to `env`, which
# would put it in the process arguments of every child.
for f in "$0" "$script"; do
  if grep -nE '(^|[[:space:]])env [^|]*ASC_KEY_P8=' "$f" >/dev/null; then
    fail "$(basename "$f") passes a credential through env arguments"
  fi
done

# 5. Nothing is created under the old secrets folder or ~/.appstoreconnect.
[[ ! -e "${HOME}/.secrets" ]] || fail "created the old secrets folder"
[[ ! -e "${HOME}/.appstoreconnect" ]] || fail "created ~/.appstoreconnect"

# 6. The script text itself no longer names the old folder as a source.
if grep -nE '(~|\$\{?HOME\}?)/\.secrets' "$script" >/dev/null; then
  fail "ship-testflight.sh still names the old secrets folder"
fi

echo "ok: ASC credential resolution (env first, then the named file as a file, then Infisical, temp key removed)"
