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
- **Build Project** — Merges workspace and base-resource LOADACS; compiles matching `#library` sources under `<pk3Root>/acs_source/`, then packages into `out/build.pk3`. Base resources supply extra library names and include paths only — they are not compiled directly. Stops without packaging on compile failure.
- **Run Project** — Runs Build Project, then launches Zandronum with the built PK3 (optional IWAD/args via `.vscode/zandronum.json`)

## Commands

### Project workflow (recommended)

| Command | What it does |
|---|---|
| **Zandronum: Compile Current ACS** | Compiles the active `.acs` file |
| **Zandronum: Build Project** | Merges workspace + base LOADACS, compiles matching workspace ACS libraries, then builds `out/build.pk3` |
| **Zandronum: Run Project** | Builds the project, then launches Zandronum on success |

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
| `zandronum-vscode.zandronumPath` | `""` | Path to the Zandronum executable (uses system PATH if empty) |
| `zandronum-vscode.pk3Root` | `"src"` | Content root packed into the PK3; resources inside get higher lookup priority |

### ACC Compiler

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.accPath` | `""` | Path to ACC executable (uses system PATH if empty) |
| `zandronum-vscode.accIncludePaths` | `""` | Additional ACC include directories (`-i`), semicolon-separated |
| `zandronum-vscode.accOutputDir` | `""` | Output directory for compiled `.o` files (relative to workspace). If empty, defaults to `<pk3Root>/acs` |

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
      "name": "Doom 2",
      "program": "C:/Games/Zandronum/zandronum.exe",
      "preArgs": ["-iwad", "C:/Games/Doom2/doom2.wad"],
      "postArgs": ["+map", "MAP01"]
    }
  ]
}
```

The extension always inserts `-file <workspace>/out/build.pk3` between `preArgs` and `postArgs`. If `.vscode/zandronum.json` is missing or empty, **Run Project** / legacy Run use the executable from settings/PATH with no extra IWAD args.

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

Content root for PK3 packaging defaults to `src/` (`pk3Root`); build output is `out/build.pk3`.
