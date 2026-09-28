# One image for the API, the worker, and the harness; each compose service picks its command.
FROM node:22-slim
# one corepack cache for the root build step and the node runtime user
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile && mkdir -p apps/harness/results && chown node apps/harness/results
USER node
# the API's default is loopback; a published port reaches the process only on the container's own address
ENV HOST=0.0.0.0
EXPOSE 8080
# node itself, not `pnpm start`: pnpm reports a child stopped by SIGTERM as a failure, so every stop would exit 1
WORKDIR /app/apps/api
CMD ["node", "--import", "tsx", "src/server.ts"]
