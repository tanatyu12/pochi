# vhs with Node, to record docs/demo.gif (scripts/demo.sh) without installing vhs, ttyd and
# ffmpeg here. Pochi runs as the bundled dist/pochi.mjs, so Node is all it adds.
FROM ghcr.io/charmbracelet/vhs:v0.12.1
COPY --from=node:22-slim /usr/local/bin/node /usr/local/bin/node
