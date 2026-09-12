# zandronum-vscode

A Visual Studio Code extension for Zandronum modding — syntax highlighting, intelligent editing, build tools, and visual editors for DECORATE, ACS, and engine lump languages.

> **Not yet published on the VS Code Marketplace.** Install from source or a VSIX package (see [Installation](#installation)).

## Requirements

- Visual Studio Code `^1.116.0`
- [ACC](https://wiki.zandronum.com/ACC) — ACS compiler (`acc` on PATH, or set `zandronum-vscode.accPath`)
- [Zandronum](https://zandronum.com/) — for Run Project (`zandronum` on PATH, or set `zandronum-vscode.zandronumPath`)

## Installation

### From source (development)

```bash
git clone <repository-url>
cd zandronum-vscode
npm install
npm run compile
```

Press **F5** in VS Code to launch an Extension Development Host with the extension loaded.

### From VSIX

```bash
npm install
npm run compile
npx @vscode/vsce package
```

Then in VS Code: **Extensions** → **…** → **Install from VSIX…** → select the generated `.vsix` file.

## Features

### Language support

| Language | Syntax | Completion | Signature | Hover | Go to Definition | Symbols | Semantic tokens | Other |
|---|---|---|---|---|---|---|---|---|
| DECORATE | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | Color preview, weapon offset preview |
| ACS | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ACC compile integration |
| SNDINFO | ✓ | ✓ | ✓ | ✓ | | | | |
| TEXTURES | ✓ | ✓ | | ✓ | | ✓ | | Folding, color preview, visual editor |
| MAPINFO | ✓ | | | | | | | |
| GLDEFS | ✓ | | | | | | | |
| MENUDEF | ✓ | | | | | | | |
| ANIMDEFS | ✓ | | | | | | | |
| SBARINFO | ✓ | | | | | | | |
| CVARINFO | ✓ | | | | | | | |
| LANGUAGE | ✓ | | | | | | | |

Snippets are available for DECORATE (actor templates) and ACS (script templates).

Cross-file symbol resolution (DECORATE actors, ACS constants) works within the workspace and against configured [base resources](#base-resources).

### Editors

- **Texture Editor** — Visual editor for TEXTURES definitions (patch layout, offsets, scales, translation preview). Open from the editor context menu or **Open Texture Editor** command while editing a TEXTURES file.
- **Sprite Offset Editor** — Edit PNG `grAb` chunks (SLADE-compatible). Available as a custom editor for `.png` files or via **Edit Sprite Offset**.
- **Weapon Offset Preview** — Preview weapon sprite offsets from DECORATE. Use the CodeLens on relevant lines or **Preview Weapon Offset**.

### Build and Run

- **Compile Current ACS** — Compile the active `.acs` file with ACC
- **Build Project** — Merges workspace and base-resource LOADACS; compiles matching `#library` sources under `<pk3Root>/acs_source/` (skips `.o` only when newer than the entry ACS **and** its transitive `#include`s; runs ACC in parallel), then packages into `out/build.pk3`. Reports ACS vs PK3 timings. Base resources supply extra library names and include paths only — they are not compiled directly. Stops without packaging on compile failure.
- **Run Project** — Resolves the run configuration (first time or after a rename, pick one before building), saves files, runs Build Project, then launches Zandronum immediately on success using the remembered configuration
- **Select Run Configuration** — Choose or change the run configuration used by **Run Project** without building or launching

## Commands

### Project workflow (recommended)

| Command | What it does |
|---|---|
| **Zandronum: Compile Current ACS** | Compiles the active `.acs` file |
| **Zandronum: Build Project** | Merges workspace + base LOADACS, incrementally compiles matching ACS libraries (parallel ACC), then builds `out/build.pk3` |
| **Zandronum: Run Project** | Remembers the last run configuration; builds the project, then launches Zandronum on success without an extra prompt |
| **Zandronum: Select Run Configuration** | Pick the run configuration for **Run Project** (stored per workspace; no build or launch) |

### Editors

| Command | What it does |
|---|---|
| **Open Texture Editor** | Opens the visual texture editor for the current TEXTURES file |
| **Edit Sprite Offset** | Opens the sprite offset editor for a PNG file |
| **Preview Weapon Offset** | Opens weapon offset preview for the current DECORATE line |

### Base Resources

| Command | What it does |
|---|---|
| **Add Base Resource** | Adds `.pk3`, `.zip`, or directory paths to `baseResources` |
| **Refresh Base Resources** | Re-indexes configured base resources |

Legacy aliases (`Build PK3`, `Run Zandronum`, and older compile/build combinations) remain registered for keybindings and `executeCommand`, but are hidden from the Command Palette.

## Configuration

### Zandronum

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.zandronumPath` | `""` | Path to the Zandronum executable (a leading `~` is expanded; uses system PATH if empty) |
| `zandronum-vscode.pk3Root` | `"src"` | Content root packed into the PK3; resources inside get higher lookup priority |
| `zandronum-vscode.pk3LeanPack` | `false` | When true, apply `<pk3Root>/.pk3ignore` (gitignore syntax) while packaging. Default packs everything under `pk3Root` |

### ACC Compiler

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.accPath` | `""` | Path to ACC executable (uses system PATH if empty) |
| `zandronum-vscode.accIncludePaths` | `""` | Extra ACC `-i` directories (semicolon-separated). Applied after auto-resolved include dirs; ACC honors at most 15 `-i` paths total |
| `zandronum-vscode.accOutputDir` | `""` | Output directory for compiled `.o` files (relative to workspace). If empty, defaults to `<pk3Root>/acs` |
| `zandronum-vscode.accConcurrency` | `0` | Max parallel ACC processes for multi-library builds. `0` = `min(4, CPU count)` |

### Base Resources

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.baseResources` | `[]` | Read-only base resource paths loaded before the workspace for symbol resolution. Supports `.pk3`/`.zip` archives and directories. Later entries override earlier ones; workspace always wins. `.wad` and `.pk7` are not supported yet. |

Load engine or mod PK3s here so DECORATE actor names and ACS `#define` constants from those packages appear in completion, hover, and go-to-definition. Use **Add Base Resource** or edit the workspace settings directly.

### Palette (PLAYPAL)

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.playpalPath` | `""` | Path to an external PLAYPAL lump file or a directory containing one. Supports relative (workspace root) and absolute paths. Used for palette color preview in Translation properties. |

## Launch configuration (`.vscode/zandronum.json`)

Optional per-workspace launch configs for IWAD and extra args. Variables: `${workspaceFolder}`, `${buildOutput}`, `${env:VAR}`.

```json
{
  "configurations": [
    {
      "name": "Doom 2 (Windows / WSL)",
      "postArgs": ["+map", "MAP01"],
      "windows": {
        "program": "C:/Games/Zandronum/zandronum.exe",
        "preArgs": ["-iwad", "C:/Games/Doom2/doom2.wad"]
      },
      "linux": {
        "program": "/opt/zandronum/zandronum",
        "preArgs": ["-iwad", "/mnt/c/Games/Doom2/doom2.wad"]
      }
    },
    {
      "name": "Host local",
      "preArgs": ["-iwad", "C:/Games/Doom2/doom2.wad"],
      "postArgs": ["-host", "-port", "10666", "+map", "MAP01"]
    },
    {
      "name": "Join local",
      "preArgs": ["-iwad", "C:/Games/Doom2/doom2.wad"],
      "postArgs": ["-connect", "127.0.0.1:10666"]
    }
  ],
  "compounds": [
    {
      "name": "Local net test",
      "configurations": ["Host local", "Join local"]
    }
  ]
}
```

The extension always inserts `-file <workspace>/out/build.pk3` between `preArgs` and `postArgs`. If `.vscode/zandronum.json` is missing or empty, **Run Project** / legacy Run use the executable from settings/PATH with no extra IWAD args.

A leading `~` (home directory) and `${workspaceFolder}` / `${buildOutput}` / `${env:...}` variables are expanded in `program`, `preArgs`, and `postArgs`. Arguments are handed to the executable without a shell, so a value such as `-iwad ~/wads/doom2.wad` must be expanded by the extension to resolve.

**Run configuration memory:** The first **Run Project** (or **Select Run Configuration**) in a workspace with multiple entries prompts for a configuration and remembers it. Later **Run Project** runs build then launch with that choice. Use **Select Run Configuration** to switch (for example between offline play and a Host+Client compound) without building.

Each configuration may contain `windows` and `linux` overrides for `program`, `preArgs`, and `postArgs`. A platform field replaces the corresponding top-level field; omitted fields inherit the top-level value. Existing configurations without platform overrides remain valid. WSL uses the `linux` override because the extension host runs on Linux.

Run Project starts the configured executable directly with an argument array, independent of the terminal's PowerShell, Bash, or other shell syntax. Native Linux executables work normally. A Windows `.exe` may also be launched through WSL when its program path uses `/mnt/<drive>/...`; Linux absolute paths in its arguments are automatically converted with `wslpath -w` (including the workspace build output as a `\\wsl.localhost\...` UNC path). A literal `C:\...` program path is still rejected on Linux because WSL needs the mounted executable path to start it.

**Compounds** (optional): list exactly two configuration names — first is Host, second is Client. The remembered compound starts Host in terminal `Zandronum Host`, waits 2 seconds, then starts Client in `Zandronum Client`. Invalid compounds (wrong count or unknown names) show an error and do not launch.

## Supported Languages

| Language | ID | Extensions | Filenames |
|---|---|---|---|
| DECORATE | `decorate` | `.dec`, `.decorate` | `DECORATE` |
| ACS | `acs` | `.acs` | `SCRIPTS` |
| MAPINFO | `mapinfo` | | `MAPINFO` |
| SNDINFO | `sndinfo` | | `SNDINFO` |
| GLDEFS | `gldefs` | | `GLDEFS` |
| MENUDEF | `menudef` | | `MENUDEF` |
| TEXTURES | `textures` | | `TEXTURES` |
| ANIMDEFS | `animdefs` | | `ANIMDEFS` |
| SBARINFO | `sbarinfo` | | `SBARINFO` |
| CVARINFO | `cvarinfo` | | `CVARINFO` |
| LANGUAGE | `language` | | `LANGUAGE` |

## Development

```bash
npm install          # install dependencies
npm run compile      # build TypeScript → out/
npm run watch        # watch mode
npm run lint         # ESLint
npm test             # extension tests (compile + lint + vscode-test)
```

Content root for PK3 packaging defaults to `src/` (`pk3Root`); build output is `out/build.pk3`. The PK3 is a store (uncompressed) ZIP of **files only**, with entry paths using `/` — empty directory entries are never written (ZDoom/Zandronum would otherwise treat Windows-style `\` directory entries as zero-byte texture lumps).

### Lean pack (`.pk3ignore`)

Set `zandronum-vscode.pk3LeanPack` to `true` to filter the archive with `<pk3Root>/.pk3ignore` (same syntax as `.gitignore`; paths relative to `pk3Root`). There is no built-in exclude list — add your own rules. Example:

```gitignore
# ACS sources — engine loads acs/*.o via LOADACS only
acs_source/
**/*.acs
```

Do not blanket-exclude `*.txt` (special lumps like `DECORATE.txt` / `LOADACS.txt` must remain). `.pk3ignore` itself is never packed. If lean pack is on but the file is missing, packaging stays full (no error).
