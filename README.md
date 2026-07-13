# zandronum-vscode

A Visual Studio Code extension for Zandronum modding, providing modern IDE support for DECORATE, ACS, and special lump languages.

## Features

- **Syntax highlighting**: DECORATE, ACS
- **Intelligent completion**: Action functions, properties, flags, expressions (DECORATE); built-in functions and constants (ACS)
- **Signature help**: Parameter hints for action functions and ACS built-ins
- **Hover documentation**: Function signatures with parameter descriptions
- **ACS compilation**: Compile `.acs` files with ACC, integrated error diagnostics
- **PK3 building**: Package workspace files into a PK3 archive
- **Build and Run**: Launch Zandronum with the built PK3 (optionally after compiling ACS)
- **Snippets**: Actor templates (DECORATE), script templates (ACS)

## Build and Run

Command Palette entries:

| Command | What it does |
|---|---|
| **Build PK3** | Zips `<pk3Root>/` (default `src/`) into `out/build.pk3` |
| **Run Zandronum** | Starts Zandronum with `-file out/build.pk3` (does not rebuild) |
| **Build and Run Zandronum** | Builds PK3, then launches only if the build succeeded |
| **Compile All ACS, Build and Run** | Compiles all LOADACS libraries, builds PK3, then launches on success |

### Zandronum executable

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.zandronumPath` | `""` | Path to the Zandronum executable (uses system PATH if empty) |
| `zandronum-vscode.pk3Root` | `"src"` | Content root packed into the PK3 |

### Launch configuration (`.vscode/zandronum.json`)

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

The extension always inserts `-file <workspace>/out/build.pk3` between `preArgs` and `postArgs`. If `.vscode/zandronum.json` is missing or empty, Run uses the executable from settings/PATH with no extra IWAD args.

## Configuration

### ACC Compiler

| Setting | Default | Description |
|---|---|---|
| `zandronum-vscode.accPath` | `""` | Path to ACC executable (uses system PATH if empty) |
| `zandronum-vscode.accIncludePaths` | `""` | Additional ACC include directories (`-i`), semicolon-separated |
| `zandronum-vscode.accOutputDir` | `"src/acs"` | Output directory for compiled `.o` files |

### Non-Standard File Extensions

Some lump files may carry extensions that conflict with other languages (e.g., `TEXTURES.class` is recognized as Java). Add these to your settings:

```jsonc
"files.associations": {
    "TEXTURES.*": "textures",
    "MAPINFO.*": "mapinfo",
    "SNDINFO.*": "sndinfo",
    "GLDEFS.*": "gldefs",
    "MENUDEF.*": "menudef",
    "ANIMDEFS.*": "animdefs",
}
```

These associations have the highest priority and will not affect other users.

## Supported Languages

| Language | ID | Extensions | Filenames |
|---|---|---|---|
| DECORATE | `decorate` | `.dec`, `.decorate` | `DECORATE` |
| ACS | `acs` | `.acs` | `SCRIPTS` |
