# syntax=docker/dockerfile:1

FROM node:22-alpine

# Small init process so SIGTERM reaches Node and graceful shutdown actually
# runs. Without this, PID 1 is node and signal handling is unreliable.
RUN apk add --no-cache tini

WORKDIR /usr/src/app

# Dependencies first so a code-only change reuses this cached layer.
COPY package.json package-lock.json* ./

# `npm ci` installs the exact tree from package-lock.json — reproducible, and
# the same bits every rebuild. The previous Dockerfile ran `npm install -g
# npm@latest` on every build, which made builds non-deterministic and was what
# broke when npm 12 required a newer Node than the base image shipped.
RUN npm ci --omit=dev || npm install --omit=dev

COPY server.js ./
COPY src ./src
COPY scripts ./scripts

# Data lives on a mounted volume; create it with the right owner up front.
RUN mkdir -p /usr/src/app/data && chown -R node:node /usr/src/app

# Drop root. A container escape from an unprivileged process is a much smaller
# problem than one from root, and nothing here needs privileges.
USER node

ENV NODE_ENV=production \
    PORT=3000 \
    DATA_DIR=/usr/src/app/data

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/sbin/tini", "--"]
CMD ["node", "server.js"]
