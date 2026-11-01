# Static site on unprivileged nginx plus the request mailer (Node), one image for both Compose services.
# Contract of the shared CI (seitenschwung/template): port 8080, GET /healthz, GET /version.txt (= APP_VERSION),
# non-root USER, read-only root fs. The mailer runs as its own service: node /app/mailer/server.mjs.

FROM node:22-alpine AS mailer-deps
WORKDIR /app/mailer
COPY mailer/package.json mailer/package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund

# Only what the pages actually reference goes live. Everything else in assets/ (originals, unused MRI pictures,
# the screenshot with patient data) stays in the repository.
FROM alpine:3.24 AS site
WORKDIR /site
COPY index.html impressum.html datenschutz.html robots.txt sitemap.xml ./
COPY fancy/index.html ./fancy/
COPY assets/ ./assets/
RUN rm -f assets/v2/l4-l5-disc-herniation.png \
 && find assets -type f | while read -r f; do \
      grep -qF "$(basename "$f")" index.html fancy/index.html impressum.html datenschutz.html || rm "$f"; \
    done \
 && find assets -type d -empty -delete

# CI runs this stage (docker build --target test): mailer tests and a check that no patient picture ships.
FROM node:22-alpine AS test
WORKDIR /app
COPY mailer/ ./mailer/
COPY --from=site /site/ ./site/
RUN cd mailer && npm ci --no-audit --no-fund && node --test *.test.mjs
RUN ! find site -iname '*herniation*' -o -iname '*sagittal*' | grep . \
 && test -f site/index.html && test -f site/fancy/index.html && test -f site/impressum.html && test -f site/datenschutz.html

FROM nginxinc/nginx-unprivileged:1.31-alpine
ARG APP_VERSION=dev
USER root
RUN apk add --no-cache nodejs
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=site /site/ /usr/share/nginx/html/
COPY --from=mailer-deps /app/mailer/node_modules /app/mailer/node_modules
COPY mailer/package.json mailer/lib.mjs mailer/server.mjs /app/mailer/
RUN printf '%s' "$APP_VERSION" > /usr/share/nginx/html/version.txt
USER 101
