# Everything CI runs.
ci:
    nix fmt -- --ci
    pnpm install --frozen-lockfile
    biome check
    pnpm exec tsc -p .
    pnpm build

# The page to try voice on, at localhost:5173.
dev:
    pnpm dev
