FROM denoland/deno:alpine

WORKDIR /app

# Cache dependencies
COPY package.json ./
RUN deno install || true

# Copy source
COPY . .

# Cache source files
RUN deno cache src/deno/main.ts

EXPOSE 5000

CMD ["deno", "run", "--allow-net", "--allow-env", "--allow-read", "--allow-write", "--allow-sys", "--allow-ffi", "src/deno/main.ts"]
