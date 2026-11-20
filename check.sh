#!/usr/bin/env bash
# Acceptance checklist. Each step is independent and reports what it did.
set -uo pipefail
cd "$(dirname "$0")"

STATUS=0

# The committed index.html is a generated artifact (src/page.template.html +
# a bundle of src/*.js + styles.css), and it is the file to open. Until now
# check.sh never looked at it, so CI could print ALL CHECKS PASSED while
# validating an artifact that no longer matched its source -- which is exactly
# what happened during a rendering change: several probe cycles measured a stale
# bundle and concluded the edit had done nothing.
#
# The check rebuilds into a scratch path and compares bytes. It does not rewrite
# index.html in place: a test step that silently fixes the tree would hide the
# staleness it exists to detect.
echo "== 0/4 artifact is current =="
if NODE=$(command -v node || true) && [[ -n $NODE ]]; then
  BUILD_TMP=$(mktemp -d "${TMPDIR:-/tmp}/re-build.XXXXXX")
  cp -a index.html "$BUILD_TMP/committed-index.html"
  if "$NODE" tools/build-standalone.mjs >/dev/null 2>"$BUILD_TMP/build.err"; then
    if cmp -s index.html "$BUILD_TMP/committed-index.html"; then
      echo "index.html matches its sources"
    else
      echo "FAIL: index.html is stale -- it differs from a fresh build of src/ and styles.css." >&2
      echo "      Regenerate with: node tools/build-standalone.mjs" >&2
      diff <(head -c 4000 "$BUILD_TMP/committed-index.html") <(head -c 4000 index.html) \
        | head -20 >&2 || true
      STATUS=1
    fi
  else
    echo "FAIL: the standalone build itself failed." >&2
    sed "s/^/      /" "$BUILD_TMP/build.err" >&2
    STATUS=1
  fi
  # Restore the committed artifact either way so the rest of the run, and the
  # working tree, see exactly what was checked out.
  cp -a "$BUILD_TMP/committed-index.html" index.html
  rm -rf "$BUILD_TMP"
else
  echo "FAIL: node is not on PATH, so the artifact cannot be rebuilt or verified." >&2
  STATUS=1
fi


# Deno does the type check and runs the unit suite. A hardcoded store path used
# to sit here as a fallback, which worked on the machine that wrote it and named
# a path no other machine has. `nix-shell shell.nix` puts deno on PATH, so it is
# looked up rather than guessed.
#
# A phase that cannot run FAILS the run rather than skipping it. An acceptance
# checklist that prints ALL CHECKS PASSED after executing nothing is worse than
# one that errors, and that is exactly what this script used to do: with deno
# off PATH and the browser out-links absent it printed ALL CHECKS PASSED and
# exited 0 having run zero tests.
DENO=${DENO:-$(command -v deno || true)}
if [[ -z $DENO ]]; then
  # The clear error, rather than the old hardcoded /nix/store/<hash> path that
  # resolved only on the machine that wrote it. A Nix-backed fallback was tried
  # and rejected: it needs network access, so it could not be verified here,
  # and silently reaching for the network to run one's own test suite is a poor
  # default. Naming the fix beats guessing at it.
  echo "deno is not on PATH. Run it inside the project shell: nix-shell shell.nix --run ./check.sh" >&2
fi

echo "== 1/4 type check =="
if [[ -z $DENO ]]; then
  echo "FAIL: deno unavailable, so nothing here has been type checked." >&2
  STATUS=1
else
  "$DENO" check --no-lock --allow-import src/*.js \
    && echo "types ok" || STATUS=1
fi

echo
echo "== 2/4 unit + wiring tests =="
# The wiring test shells out to the standalone build, so it needs what that
# build needs: --allow-run for the esbuild spawn, --allow-env to read $ESBUILD,
# --allow-write for the .tmp directory esbuild writes through.
if [[ -z $DENO ]]; then
  echo "FAIL: deno unavailable, so no unit test ran." >&2
  STATUS=1
else
  "$DENO" test --no-lock --no-check --allow-read --allow-env --allow-run \
    --allow-write="$PWD/.tmp" \
    tests/engine.test.js tests/wiring.test.mjs tests/png.test.mjs tests/serve.test.mjs \
    || STATUS=1
fi

echo
echo "== 3/4 browser smoke test =="
if [[ -x .gc-roots/node/bin/node && -e .gc-roots/pw/index.js ]]; then
  PATH="$PWD/.gc-roots/node/bin:$PATH" \
  PLAYWRIGHT_BROWSERS_PATH="$PWD/.gc-roots/browsers" \
    node tests/browser.test.mjs || STATUS=1
else
  echo "FAIL: browser toolchain absent, so no page was painted. Bootstrap with:" >&2
  STATUS=1
  echo
  echo "  nix-build gcroots.nix -A pw        --out-link .gc-roots/pw"
  echo "  nix-build gcroots.nix -A browsers  --out-link .gc-roots/browsers"
  echo "  nix-build gcroots.nix -A node      --out-link .gc-roots/node"
fi

echo
if [[ $STATUS -eq 0 ]]; then echo "ALL CHECKS PASSED"; else echo "SOME CHECKS FAILED"; fi
exit $STATUS
