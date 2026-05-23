# zandronum-vscode

A Visual Studio Code extension for Zandronum modding, providing modern IDE support for DECORATE, ACS, and special lump languages.

## Features

- **Syntax highlighting**: DECORATE, ACS
- **Intelligent completion**: Action functions, properties, flags, expressions (DECORATE); built-in functions and constants (ACS)
- **Signature help**: Parameter hints for action functions and ACS built-ins
- **Hover documentation**: Function signatures with parameter descriptions
- **ACS compilation**: Compile `.acs` files with ACC, integrated error diagnostics
- **PK3 building**: Package workspace files into a PK3 archive
- **Snippets**: Actor templates (DECORATE), script templates (ACS)

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
