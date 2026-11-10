#!/bin/bash
# CLOUDFLARE_API_TOKEN: environment first, else `fleet-secrets get` (Infisical Fleet-OPS).
if [[ -z "${CLOUDFLARE_API_TOKEN:-}" ]]; then
  CLOUDFLARE_API_TOKEN="$(fleet-secrets get CLOUDFLARE_API_TOKEN 2>/dev/null || true)"
fi
export CLOUDFLARE_API_TOKEN
# Use the correct old account ID where the bucket lives for now
export CLOUDFLARE_ACCOUNT_ID="254301ba6b6323381932ddbca9608c73"

BASE_DIR="/Users/jay/.gemini/antigravity/brain/de3d0d13-c3a4-425c-9fbe-a4b16407c93a/scratch/raw-pdfs"

echo "Finding all PDFs..."
find "$BASE_DIR" -type f -name "*.pdf" > pdf_files.txt

TOTAL=$(wc -l < pdf_files.txt | awk '{print $1}')
echo "Found $TOTAL PDFs to upload."

# Create an upload script for xargs
cat << 'INNER_EOF' > do_upload.sh
#!/bin/bash
FILE=$1
# Extract relative path (chamber/year/docId.pdf)
REL_PATH=$(echo "$FILE" | sed 's|.*/scratch/raw-pdfs/||')
npx wrangler r2 object put "congress-trade-bucket/raw-pdfs/$REL_PATH" --file "$FILE" > /dev/null 2>&1
echo "Uploaded $REL_PATH"
INNER_EOF
chmod +x do_upload.sh

echo "Starting concurrent upload..."
cat pdf_files.txt | xargs -n 1 -P 20 ./do_upload.sh

echo "Done uploading."
