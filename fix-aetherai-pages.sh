#!/usr/bin/env bash
# fix-aetherai-pages.sh
# Fixes the white screen on https://wwoooho2-gif.github.io/AetherAI/
# Run it from the root of your AetherAI repo:  bash fix-aetherai-pages.sh
set -euo pipefail

REPO_NAME="AetherAI"
BASE="/${REPO_NAME}/"

say()  { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
warn() { printf '\033[1;33m!! %s\033[0m\n' "$*"; }
die()  { printf '\033[1;31mxx %s\033[0m\n' "$*"; exit 1; }

# --- 0. sanity checks -------------------------------------------------------
[ -d .git ] || die "Run this from the root of the AetherAI git repo (no .git here)."
command -v git >/dev/null || die "git not found."

BRANCH="$(git rev-parse --abbrev-ref HEAD)"
say "Repo branch: $BRANCH"

# --- 1. detect project type -------------------------------------------------
TYPE="static"
OUTDIR="."
VITE_CFG="$(ls vite.config.js vite.config.ts vite.config.mjs vite.config.mts 2>/dev/null | head -n1 || true)"

if [ -n "$VITE_CFG" ]; then
  TYPE="vite"; OUTDIR="dist"
elif [ -f package.json ] && grep -q '"react-scripts"' package.json; then
  TYPE="cra"; OUTDIR="build"
elif [ -f package.json ] && grep -q '"build"' package.json; then
  TYPE="other-node"; OUTDIR="dist"
fi

if [ -f package.json ] && grep -q '"electron"' package.json && [ "$TYPE" != "vite" ]; then
  warn "This looks like an Electron/desktop app. It may need a backend or Electron APIs"
  warn "and can't fully run on a static host. The path fixes below still help, but if the"
  warn "console shows errors about 'electron' or 'require', you need a separate web build."
fi

say "Detected project type: $TYPE (publish folder: $OUTDIR)"

# --- 2. fix the base path ---------------------------------------------------
case "$TYPE" in
  vite)
    if grep -qE "base\s*:" "$VITE_CFG"; then
      sed -i -E "s#base\s*:\s*[^,}]+#base: '${BASE}'#" "$VITE_CFG"
    elif grep -q "defineConfig({" "$VITE_CFG"; then
      sed -i "0,/defineConfig({/s//defineConfig({\n  base: '${BASE}',/" "$VITE_CFG"
    elif grep -q "export default {" "$VITE_CFG"; then
      sed -i "0,/export default {/s//export default {\n  base: '${BASE}',/" "$VITE_CFG"
    else
      warn "Couldn't patch $VITE_CFG automatically. Add  base: '${BASE}'  to it yourself."
    fi
    grep -n "base" "$VITE_CFG" || true
    ;;
  cra)
    command -v node >/dev/null || die "node not found."
    node -e '
      const fs=require("fs");
      const p=JSON.parse(fs.readFileSync("package.json","utf8"));
      p.homepage="https://wwoooho2-gif.github.io/'"$REPO_NAME"'";
      fs.writeFileSync("package.json",JSON.stringify(p,null,2)+"\n");
    '
    echo "Set homepage in package.json"
    ;;
  static)
    if [ -f index.html ]; then
      # /file.js -> ./file.js (leaves // and http:// links alone)
      sed -i -E 's#(src|href)="/([^/"])#\1="./\2#g' index.html
      echo "Rewrote root-relative links in index.html to relative links"
    else
      warn "No index.html in repo root. Check where your site's entry file lives."
    fi
    ;;
  other-node)
    warn "Unknown build tool. Set its public path/base to '${BASE}' manually."
    ;;
esac

# --- 3. GitHub Actions workflow to build + deploy ---------------------------
say "Writing .github/workflows/pages.yml"
mkdir -p .github/workflows

if [ "$TYPE" = "static" ]; then
  cat > .github/workflows/pages.yml <<EOF
name: Deploy to GitHub Pages
on:
  push:
    branches: [${BRANCH}]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  deploy:
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    steps:
      - uses: actions/checkout@v4
      - uses: actions/upload-pages-artifact@v3
        with:
          path: .
      - uses: actions/deploy-pages@v4
EOF
else
  cat > .github/workflows/pages.yml <<EOF
name: Deploy to GitHub Pages
on:
  push:
    branches: [${BRANCH}]
  workflow_dispatch:
permissions:
  contents: read
  pages: write
  id-token: write
concurrency:
  group: pages
  cancel-in-progress: true
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: if [ -f package-lock.json ]; then npm ci; else npm install; fi
      - run: npm run build
      - uses: actions/upload-pages-artifact@v3
        with:
          path: ${OUTDIR}
  deploy:
    needs: build
    runs-on: ubuntu-latest
    environment:
      name: github-pages
    steps:
      - uses: actions/deploy-pages@v4
EOF
fi

# --- 4. local test build ----------------------------------------------------
if [ "$TYPE" != "static" ]; then
  say "Test build (so we catch errors before pushing)"
  command -v npm >/dev/null || die "npm not found. Install nodejs/npm first."
  if [ -f package-lock.json ]; then npm ci; else npm install; fi
  npm run build || die "Build failed. Fix the error above, then run this script again."
  [ -d "$OUTDIR" ] || warn "Build finished but '$OUTDIR' doesn't exist. Edit the 'path:' in .github/workflows/pages.yml."
fi

# --- 5. commit + push -------------------------------------------------------
say "Changes to be committed:"
git add -A
git status --short

read -r -p "Commit and push to origin/${BRANCH}? [y/N] " ans
if [[ "$ans" =~ ^[Yy]$ ]]; then
  git commit -m "Fix GitHub Pages base path and add Pages deploy workflow" || true
  git push origin "$BRANCH"
  say "Pushed."
  cat <<MSG

Last manual step (one time only):
  GitHub repo -> Settings -> Pages -> Source -> choose "GitHub Actions"

Then watch the Actions tab for a green run and hard-refresh the site (Ctrl+Shift+R):
  https://wwoooho2-gif.github.io/${REPO_NAME}/
MSG
else
  warn "Not pushed. Review with 'git diff --staged', then commit and push yourself."
fi
