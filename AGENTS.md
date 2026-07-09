# AGENTS.md

## Project Overview

This project is a modern Visual Studio Code extension for developing mods for the Zandronum engine.

The goal is to provide a development experience comparable to official Microsoft VSCode language extensions such as Python and C/C++.

The extension aims to support all major Zandronum-related languages and workflows, including:

* DECORATE
* ACS

DECORATE is not case-sensitive.

And special lumps for Zandronum, including (Note: These special lumps are identified by their filename, not their file extension. File extensions can be any name):

* ALTHUDCF
* ANCRINFO
* ANIMDEFS
* AUTHINFO
* BOTINFO
* CVARINFO
* CMPGNINF
* DECALDEF
* DECORATE
* DEHACKED
* DEHSUPP (deprecated)
* DMXGUS
* FSGLOBAL
* FONTDEFS
* GAMEINFO
* GAMEMODE
* GLDEFS
* KEYCONF
* LANGUAGE
* LOADACS
* LOCKDEFS
* MAPINFO
* MEDALDEF
* MENUDEF
* MODELDEF
* MUSINFO
* SBARINFO
* SCORINFO
* SCRIPTS
* SECRETS
* SECTINFO
* SKININFO
* SNDINFO
* SNDSEQ
* TEAMINFO
* TERRAIN
* TEXTCOLO
* TEXTURES
* VOXELDEF
* VOTEINFO
* XHAIRS
* X11R6RGB
* and other engine resource formats

The project focuses on:

* syntax highlighting
* intelligent completion
* hover/documentation
* snippets
* signature help
* diagnostics/error checking
* formatting
* compile/build integration
* PK3 or PK7 packaging workflow


## Engine Compatibility

Target engine:

Zandronum only. Zandronum is based on ZDoom 2.8pre-441-g458e1b1 and GZDoom 1.8.6.

Do not use:
- ZScript
- post ZDoom 2.8pre-441-g458e1b1 language features
- post GZDoom 1.8.6 language features

If uncertain, assume the feature is NOT available.

---



## Semantic Tokens

TextMate Grammar handles:

- built-in functions
- built-in properties
- built-in flags
- built-in constants

Semantic Tokens handle:

- user-defined variables
- user-defined constants
- future user-defined symbols

Avoid duplicating TextMate functionality in Semantic Tokens.


# Core Design Philosophy

## 1. Avoid Overengineering

This project should remain lightweight and maintainable.

Do NOT introduce:

* unnecessary abstractions
* excessive interfaces
* dependency injection frameworks
* language servers unless truly needed
* AST systems before they become necessary

Prefer:

* simple modules
* explicit logic
* readable TypeScript
* incremental improvements

---

## 2. Data-Driven Language Features

Language metadata should primarily come from JSON data files.

Examples:

* actions.json
* properties.json
* flags.json
* expressions.json

The extension should generate:

* completion
* snippets
* signatures
* hover documentation

from structured metadata whenever possible.

Avoid duplicating information such as hardcoded signatures.

---

## 3. Runtime Generation Over Redundant Storage

Do NOT store generated strings when they can be derived from structured data.

For example:

* generate function signatures from params
* generate snippets from params
* generate hover markdown dynamically

Avoid redundant fields like:

```json
"signature": "A_Chase(...)"
```

when the same information already exists in params.

---

## 4. Performance First

Avoid repeated runtime allocation and full-table scans.

Preferred patterns:

* startup caching
* prebuilt CompletionItems
* indexed lookup tables
* lightweight parsing

Avoid:

```ts
Object.entries(...).forEach(...)
```

inside hot completion paths whenever possible.

---

# Extension Scope

## DECORATE Support

Planned features:

* syntax highlighting
* intelligent completion
* snippets
* hover
* signature help
* diagnostics
* formatter
* actor/state analysis
* flag completion
* expression completion

Supported language concepts include:

* action functions
* properties
* actor flags
* states
* labels
* sprite frames
* expressions
* constants

## DECORATE Metadata Rules

Users cannot define:

- new action functions
- new actor properties
- new built-in flags

Therefore:

- actions.json is authoritative
- properties.json is authoritative
- flags.json is authoritative

Completion providers should not attempt to discover additional built-in symbols from source files.

---

## ACS Support

Planned features:

* syntax highlighting
* completion
* snippets
* hover
* diagnostics
* formatter
* compile integration

Supported concepts include:

* script types
* ACS functions
* flags
* constants
* labels
* preprocessor directives

---

# Build System

The extension should support:

* ACS compilation
* PK3 building
* combined compile + build workflows

Build logic should remain independent from language providers.

---

# Recommended Project Structure

```text
data/               Static metadata JSON files
syntaxes/           TextMate grammars
snippets/           VSCode snippets
media/              Webview assets (JS, CSS for custom editors)
src/language/       Language-related providers
src/language/textures/  TEXTURES language + visual texture editor
src/tools/          Build/compile utilities
src/tools/png/      PNG parsing tools (reusable outside editors)
src/editors/        Custom editors (sprite offset, etc.)
src/editors/providers/  Format-specific SpriteImageProvider implementations
```

---

# Texture Editor

## Architecture

The TEXTURES visual editor is a **WebviewPanel** (not a CustomEditorProvider) opened beside a TEXTURES text document via `textures.openEditor`.

**Layer separation:**
- `src/language/textures/texturesParser.ts` — structural parse of definitions, patches, texture/patch properties + editable ranges
- `src/language/textures/textureDocumentModel.ts` — resource resolution, WorkspaceEdit writers (move/props/CRUD)
- `src/language/textures/textureDocumentController.ts` — document sync, panel messages, registry lifecycle
- `src/language/textures/textureEditorPanel.ts` — WebviewPanel host + view DTOs
- `media/textureEditor.js` / `.css` — canvas preview, guides, inspector UI

**Key behaviors (SLADE-aligned):**
- Offset Type guides: None / Sprite (floor + origin cross) / HUD (centered 320×200 screen; Offset from screen top-left; crosshair + status-bar guide at y=168)
- Texture Size, Offset, XScale/YScale editing (inverse scale: 2 = half size)
- Patch X/Y, FlipX/Y, Rotate (0/90/180/270), Alpha, UseOffsets (PNG grAb via `src/tools/png/`)
- Translation preview via PLAYPAL nearest-index remap (`src/tools/translation.ts` + webview)
- Multi-patch add / remove / reorder / duplicate
- Document text is source of truth; undo via VS Code document undo

---

# Sprite Offset Editor

## Architecture

The sprite offset editor is a CustomEditorProvider for visually editing image offsets (grAb chunk in PNG).

**Offset semantics (Doom/ZDoom):**
- Offset represents the pixel inside the image aligned with world origin
- `screenX = originX - offset.x`, `screenY = originY - offset.y`
- Drag right → offset.x decreases; Drag up → offset.y increases

**Layer separation:**
- `src/tools/png/` — Pure PNG tools (crc32, chunk reader, grAb), no vscode dependency, reusable
- `src/editors/spriteImage.ts` — Interfaces (`SpriteImageProvider`, `SpriteOffset`, `AutoOffsetPreset`)
- `src/editors/providers/` — Format-specific implementations (PngSpriteProvider)
- `src/editors/spriteOffsetEditorProvider.ts` — CustomEditorProvider (depends only on interfaces)
- `media/spriteOffsetEditor.js` — Webview (pure display + interaction, NO business logic)

**Key patterns:**
- Provider factory: `createSpriteProvider(Uint8Array, Uri)` — format detection, returns interface
- Provider takes `Uint8Array` as data source (not fs path), enabling future PK3 support
- Shared FileSystemWatcher (`**/*.png`) on the provider class, not per-document
- V1 uses `CustomDocumentContentChangeEvent` for dirty tracking (no undo/redo)
- Auto offset presets defined as `AutoOffsetPreset[]` array, not hardcoded
- View modes: Sprite (floor line) and Weapon (320×200 reference frame with anchor at 160,168)

**Constants:**
```ts
WEAPON_ANCHOR_X = 160
WEAPON_ANCHOR_Y = 168
WEAPON_REFERENCE_WIDTH = 320
WEAPON_REFERENCE_HEIGHT = 200
```

## SLADE Compatibility

The grAb chunk must be interoperable with SLADE3:
- Chunk type: `grAb` (case-sensitive)
- Data: 8 bytes — int32 big-endian X, int32 big-endian Y
- Placed after IHDR chunk
- CRC32 calculated over type + data (standard PNG CRC)

## Future Expansion (V2)

- Undo/Redo via `CustomDocumentEditEvent`
- Doom Gfx / Doom Patch format support (new providers)
- PK3 virtual file support
- Grid overlay

---

# Code Style Guidelines

## TypeScript

Prefer:

* explicit naming
* small functions
* early returns
* clear control flow

Avoid:

* deeply nested logic
* giant provider files
* unnecessary classes

Use interfaces for structured metadata.

---

## Completion Providers

Completion providers should:

* be context-aware
* avoid irrelevant suggestions
* minimize allocations during typing
* support future extension

Context detection is preferred over global completion spam.

---

## Signature Help

Signature help should:

* be dynamically generated
* support optional parameters
* support bitmask flag parameters
* correctly track activeParameter

---

## Bitmask Flags

Bitmask flag parameters should support:

```text
CHF_FASTCHASE | CHF_DONTMOVE
```

The completion system should:

* continue completion after "|"
* avoid replacing previous flags
* optionally filter duplicate flags

---

# AI Contribution Guidelines

When generating code:

* prefer modifying existing logic over full rewrites
* avoid massive refactors
* preserve current architecture unless necessary
* keep implementations understandable
* generate incremental changes

Do NOT:

* introduce unnecessary frameworks
* split files excessively
* replace working systems without clear benefit

---

# Long-Term Goals

Future goals may include:

* semantic analysis
* cross-file references
* goto definition
* symbol indexing
* workspace-wide diagnostics

However, current development should prioritize:

1. stability
2. usability
3. maintainability
4. performance
5. incremental progress

over architectural complexity.

## AI Output Rules

Before generating code:

1. Explain implementation plan.
2. List affected files.
3. Prefer minimal diffs.
4. Avoid full file rewrites.

Unless explicitly requested:

- do not generate complete files
- do not perform large refactors
- do not change project architecture

---

# Common Pitfalls

Lessons learned from bugs encountered during development. Apply these checks before committing.

## Regex Case Sensitivity

ACS preprocessor directives (`#DEFINE`, `#include`, `#library`) are **case-insensitive**. JavaScript regexes must use the `/i` flag.

```ts
// WRONG — misses #DEFINE, #Define
/^\s*#\s*define\s+(\w+)/

// RIGHT
/^\s*#\s*define\s+(\w+)/i
```

The Oniguruma `(?i)` inline flag used in TextMate grammars does NOT behave identically to JavaScript's `/i`. Prefer separate character classes over inline flags:

```json
// WRONG — (?i) makes [A-Z] match lowercase too, causing false positives on lowercase identifiers
"(?i)\\b[A-Z][A-Z0-9_]{2,}\\b"

// RIGHT — explicit mixed-case class, first char uppercase only
"\\b[A-Z][A-Za-z0-9_]{2,}\\b"
```

## Semantic Tokens vs TextMate Priority

VSCode semantic tokens **always override** TextMate grammar scopes. When adding semantic token logic:

1. List all scopes that TextMate correctly handles (functions, printcasts, built-in constants)
2. Add explicit `continue` conditions in Pass 2 to skip those tokens
3. **Check order matters**: constants must be evaluated BEFORE the function-call skip and BEFORE variables

```ts
// Correct Pass 2 order:
// 1. Printcast skip (s:, d:, c: etc.)
// 2. consts (local → cross → built-in)   ← before fn-skip
// 3. Function-call skip (\s*\()
// 4. vars (local → cross)
```

## Comma Splitting in Declarations

Never split declaration tails by comma without first removing parenthesized content. Function call arguments inside initializers contain commas that get falsely interpreted as variable separators.

```ts
// WRONG — APROP_Alpha treated as a variable name
const tail = "baseAlpha = GetActorProperty(0, APROP_Alpha)";
const parts = tail.split(',');  // ["baseAlpha = GetActorProperty(0", " APROP_Alpha)"]

// RIGHT — strip parens first
let cleaned = tail;
do {
    cleaned = cleaned.replace(/\([^()]*\)/g, '');
} while (cleaned !== prev);
const parts = cleaned.split(',');
```

## Multi-Line Declarations

Variable declarations can span multiple lines with `{` initializers. Regex patterns requiring `;` on the same line will miss them.

```ts
// WRONG — misses team_color_palette because { is on the same line, no ;
/\b(int|str|bool|fixed)\s+([^;]+);/gi

// RIGHT — tolerate end-of-line without semicolon
/\b(int|str|bool|fixed)\s+([^;]+)(?:;|$)/gi
```

## Source Text Structural Scanning

When counting `{`/`}` for scope tracking (brace depth), **always strip comments and strings first**. Otherwise braces inside `//`, `/* */`, and `"..."` corrupt the count.

```ts
// WRONG
for (const ch of text) {
    if (ch === '{') depth++;
}

// RIGHT
const cleaned = stripCommentsAndStrings(text);
for (const ch of cleaned) {
    if (ch === '{') depth++;
}
```

**Use previous-line depth** (`depthBefore`) for the current line's scope decision, then count the current line's braces for subsequent lines.

```ts
const depthBefore = braceDepth;
// ... detection uses depthBefore ...
// Count braces for next iteration:
const cleaned = stripCommentsAndStrings(text);
for (const ch of cleaned) { /* update braceDepth */ }
```

## Compiler Exit Code vs Output Artifact

Do not rely solely on compiler exit code to determine success. Some compilers (including ACC) may exit 0 but still fail to produce output, or output preamble text that looks like errors.

```ts
// WRONG
if (code === 0 && diagnostics.length === 0) resolve(true);

// RIGHT — check that the output file actually exists
const oExists = fs.existsSync(outFile);
if (code === 0 && totalDiags === 0 && oExists) resolve(true);
```

## Multi-File Error Diagnostics

Compiler output references errors in multiple files (source file + its `#include` targets). Return diagnostics grouped by file, not filtered to the source file alone.

```ts
// WRONG — errors in included files are lost
function parseAcsErrors(output, srcFile): Diagnostic[] {
    if (file !== srcFile) continue; // drops include-file errors
}

// RIGHT — report for every file mentioned
function parseAcsErrors(output): Map<string, Diagnostic[]> {
    // key = file path, value = diagnostics for that file
}
```

## Include Path Resolution for ACC

ACC searches its **own executable directory** for standard libraries (`zcommon.acs`). Include path resolution must add the ACC directory. Also, add all **subdirectories of the source tree** so that `#include "common/file.acs"` works regardless of nesting.

```ts
// Must include:
// 1. ACC executable directory (for zcommon.acs etc.)
// 2. Source directory + all subdirectories (for nested includes)
```

## TypeScript Visibility for Registration Functions

Methods called from `register*` functions in the same file but outside the class body must be `public` (not `private`).

```ts
// WRONG
class Provider {
    private clearCache(): void { ... }
}
register() { provider.clearCache(); } // ❌ 'clearCache' is private

// RIGHT
class Provider {
    clearCache(): void { ... }  // public by default
}
```

## Compilation Unit Architecture

When building a symbol index for cross-file analysis:

- **Do not** scan the workspace or build all CUs on `activate()`. Use lazy construction.
- **Do not** treat the currently-open file as the Compilation Unit root. CUs must be rooted at the ACTUAL library entry point (`#library` file).
- **Do not** assume a file belongs to exactly one CU. A shared `common.acs` may be included by multiple libraries. Return `CompilationUnit[]`, not a single CU.
- Make CompilationUnit and SymbolTable **immutable** after construction. On invalidate, discard and rebuild fresh instances.

## Unexpected `continue` Skipping Critical Logic

When using `continue` in loops, ensure that essential post-processing (brace counting, state updates) either:
- Runs before the `continue` statement, or
- Is restructured to use `if/else` blocks instead of `continue` so post-processing always executes.

```ts
// WRONG — brace counting never runs for function/script lines
for (line) {
    if (isFn) { ...; continue; }  // skips brace counting
    if (isSc) { ...; continue; }  // skips brace counting
    // ... brace counting here ...
}

// RIGHT — brace counting runs unconditionally
for (line) {
    const depthBefore = braceDepth;
    if (isFn) { ...; }
    else if (isSc) { ...; }
    else if (depthBefore === 0) { scanDeclarations(); }
    // Always count braces:
    for (ch of cleaned) { /* update braceDepth */ }
}
```
