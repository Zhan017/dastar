FROM node:22-slim
# one corepack cache for the root build step and the node runtime user
ENV COREPACK_HOME=/usr/local/share/corepack
RUN corepack enable
WORKDIR /app
COPY . .
RUN pnpm install --frozen-lockfile
USER node
# the API's default is loopback; a published port reaches the process only on the container's own address
ENV HOST=0.0.0.0
EXPOSE 8080
CMD ["pnpm", "--filter", "@dastar/api", "start"]
