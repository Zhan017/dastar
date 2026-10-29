# One image for the API, the worker, and the harness; each compose service picks its command.
FROM node:26-slim
WORKDIR /app
# Node.js 25 and later ship without Corepack, so the image installs the pnpm that package.json's packageManager names
COPY package.json ./
RUN spec="$(node -p 'require("./package.json").packageManager')" \
 && case "$spec" in pnpm@*) npm install -g "${spec%%+*}" ;; *) echo "packageManager names no pnpm version: $spec" >&2; exit 1 ;; esac
COPY . .
RUN pnpm install --frozen-lockfile && mkdir -p apps/harness/results && chown node apps/harness/results
USER node
# the API's default is loopback; a published port reaches the process only on the container's own address
ENV HOST=0.0.0.0
EXPOSE 8080
# node itself, not `pnpm start`: pnpm reports a child stopped by SIGTERM as a failure, so every stop would exit 1
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
