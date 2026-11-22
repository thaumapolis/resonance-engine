{
  description = "Resonance Engine: a toroidal field of coupled oscillators that is also an instrument";

  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

  outputs =
    { nixpkgs, ... }:
    let
      # Goldens are painted and compared inside one browser process, so each
      # system needs the same browser build for a baseline to mean the same
      # pixels. Only x86_64-linux is exercised by CI.
      systems = [ "x86_64-linux" ];
      forAllSystems = f: nixpkgs.lib.genAttrs systems (system: f nixpkgs.legacyPackages.${system});
    in
    {
      devShells = forAllSystems (pkgs: {
        # The same toolchain shell.nix provides, so CI, `nix develop`, and the
        # acceptance checklist agree on one environment. See shell.nix for why
        # the driver and the browser set must come from the same pkgs.
        default = pkgs.mkShellNoCC {
          packages = [
            pkgs.nodejs_22
            pkgs.deno # `deno check` and the test runner; check.sh needs it on PATH
            pkgs.esbuild # tools/build-standalone.mjs spawns this CLI to bundle
            pkgs.playwright-driver
            pkgs.firefox
            pkgs.python3
            # styles.css asks for `ui-sans-serif, system-ui`, which resolves to
            # whatever the host has. Golden images containing text therefore
            # differ between machines; fontconfig gives that keyword an answer.
            pkgs.fontconfig
            pkgs.dejavu_fonts
            pkgs.liberation_ttf
          ];

          env = {
            PLAYWRIGHT_ENTRY = "${pkgs.playwright-driver}/index.mjs";
            PLAYWRIGHT_BROWSERS_PATH = "${pkgs.playwright-driver.browsers}";
          };

          shellHook = ''
            echo "Resonance Engine: ./check.sh   (artifact, types, unit tests, browser, goldens)"
          '';
        };
      });

      packages = forAllSystems (pkgs: {
        # The artifact alone. `nix build` producing anything other than exactly
        # index.html would mean the bundler had started emitting siblings, which
        # breaks the single-file promise.
        default = pkgs.runCommand "resonance-engine" {
          src = ./.;
          nativeBuildInputs = [
            pkgs.nodejs_22
            pkgs.esbuild
          ];
        } ''
          # Build into $out, not beside the sources: a Nix source tree is a
          # read-only store path, so writing the artifact next to src/ fails.
          # tools/build-standalone.mjs finds esbuild via $ESBUILD or PATH.
          node "$src/tools/build-standalone.mjs" "$out/index.html"
          test -s "$out/index.html"
          ! grep -qE '<(script|link|img|source|iframe)[^>]+(src|href)="[^#d]' "$out/index.html" \
            || { echo "artifact references an external file"; exit 1; }
        '';
      });
    };
}
