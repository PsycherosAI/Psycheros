---

### How to install

The canonical artifact for the harness is the container image:

```bash
docker pull ghcr.io/psycherosai/psycheros:<version>
# or `:latest` for the most recent release
```

See the [README's Docker block](https://github.com/PsycherosAI/Psycheros#docker)
for the recommended `docker run` invocation, env-var reference, and volume
layout.

The archives prefixed `Psycheros-` below are GitHub's auto-attached
full-monorepo source — useful for building the image yourself, but the published
image at GHCR is the supported install path.
