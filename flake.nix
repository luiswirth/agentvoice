{
  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";

    treefmt-nix.url = "github:numtide/treefmt-nix";
    treefmt-nix.inputs.nixpkgs.follows = "nixpkgs";
  };

  outputs = {
    nixpkgs,
    treefmt-nix,
    ...
  }: let
    forEachSystem = f:
      nixpkgs.lib.genAttrs ["aarch64-darwin" "x86_64-linux"]
      (system: f nixpkgs.legacyPackages.${system});

    # One environment, entered by the shell and by the checks alike. The
    # compiler and the type definitions are pinned by pnpm instead, since
    # editors look for them in node_modules.
    # Chromium is the bench's browser, and only the server runs it.
    tools = pkgs: with pkgs; [nodejs pnpm biome just rsync ffmpeg-headless uv] ++ lib.optional stdenv.hostPlatform.isLinux chromium;
  in {
    # Every language in the tree, behind one command. The global pre-commit
    # hook checks a repository by running this, so a language left out here is
    # a language nothing checks.
    formatter = forEachSystem (pkgs:
      treefmt-nix.lib.mkWrapper pkgs {
        projectRootFile = "flake.nix";
        programs.biome.enable = true;
        # One configuration for both, rather than treefmt's own default. treefmt
        # names the files itself, and Biome would look for the ignore file next
        # to the copy in the store. Biome checks the configuration as it loads,
        # and treefmt-nix's schema lags behind it.
        programs.biome.validate.enable = false;
        programs.biome.settings = removeAttrs (builtins.fromJSON (builtins.readFile ./biome.json)) ["vcs"];
        programs.alejandra.enable = true;
        programs.just.enable = true;
      });

    # agentvoice: the page, built, and its server, which serves it on the
    # agents' machine, as server/main.ts says. It needs `agentinbox` on its
    # PATH, the inbox's command line, which delivers the person's turns.
    packages = forEachSystem (pkgs: {
      default = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
        pname = "agentvoice";
        version = "0";
        src = nixpkgs.lib.fileset.toSource {
          root = ./.;
          fileset = nixpkgs.lib.fileset.unions [
            ./package.json
            ./pnpm-lock.yaml
            ./pnpm-workspace.yaml
            ./patches
            ./index.html
            ./demo/index.html
            ./vite.config.ts
            ./tsconfig.json
            ./components.json
            ./src
            ./public
            ./server
            ./voice/package.json
            ./voice/src
          ];
        };
        nativeBuildInputs = [pkgs.nodejs pkgs.pnpm pkgs.pnpmConfigHook pkgs.makeWrapper];
        pnpmDeps = pkgs.fetchPnpmDeps {
          inherit (finalAttrs) pname version src;
          hash = "sha256-cTQvk/aQshiUvkl1RgFbjkDgcPA9pa6Ql+09TpligUY=";
          fetcherVersion = 4;
          # pnpm leaves an empty `links` in its store on Darwin only, which
          # fetchPnpmDeps keeps, so the hash would differ between platforms.
          preFixup = "rm -rf $storePath/v11/links";
        };
        buildPhase = ''
          runHook preBuild
          pnpm build
          runHook postBuild
        '';
        installPhase = ''
          runHook preInstall
          mkdir -p $out/lib/agentvoice $out/bin
          cp -r dist $out/lib/agentvoice/dist
          cp -r server $out/lib/agentvoice/server
          makeWrapper ${pkgs.lib.getExe pkgs.nodejs} $out/bin/agentvoice \
            --add-flags $out/lib/agentvoice/server/main.ts
          runHook postInstall
        '';
        meta.mainProgram = "agentvoice";
      });
    });

    devShells = forEachSystem (pkgs: {
      default = pkgs.mkShell {packages = tools pkgs;};
    });
  };
}
