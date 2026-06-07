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
data/           Static metadata JSON files
syntaxes/       TextMate grammars
snippets/       VSCode snippets
src/language/   Language-related providers
src/tools/      Build/compile utilities
```

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
