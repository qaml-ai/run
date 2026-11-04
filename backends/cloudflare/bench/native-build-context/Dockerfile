FROM node:24-trixie-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates procps time && rm -rf /var/lib/apt/lists/*
COPY workload.mjs /opt/workload.mjs
WORKDIR /workspace
CMD ["sleep", "infinity"]
