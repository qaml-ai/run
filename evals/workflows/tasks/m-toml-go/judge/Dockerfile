# The m-toml-go judge: Go and toml-test, pinned, with nothing fetched at scoring time (the container runs with no
# network). Build: docker build -t <tag> evals/workflows/tasks/m-toml-go/judge (run.ts does this, tagged by this
# file's hash).
FROM golang:1.27.3-bookworm
ENV GOTOOLCHAIN=local CGO_ENABLED=0 GOFLAGS=-mod=mod
RUN go install github.com/toml-lang/toml-test/v2/cmd/toml-test@v2.2.0 && toml-test version
