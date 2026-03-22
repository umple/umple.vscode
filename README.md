# Umple for VS Code

A VS Code extension for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files.

Umple enables textual description of data models (class diagrams) and state models (finite state machines) with embedded code in Java, Python, C++ and other languages, along with generation of high quality code in those languages. Umple enables extensive analysis of models, as well as generation of diagrams, example data and many other outputs. Special features of Umple include specification of product lines (using mixsets), code injection (aspects), code snippet management (traits) and so on. Umple can scale to systems of any size, but its codebase will always be much smaller than software written directly in target languages due to Umple eliminating much boilerplate code. Umple can complement LLM-generation of code: You can arrange for your AI to generate Umple.

[This plugin is listed in the VSCode Marketplace](https://marketplace.visualstudio.com/items?itemName=digized.umple)

## Features of the Umple Plugin

### Language Intelligence (via LSP)

- **Diagnostics** — Real-time error and warning detection via the Umple compiler
- **Go-to-definition** — Jump to classes, interfaces, traits, enums, attributes, methods, state machines, states, associations, mixsets, and requirements
- **Find references** — Semantic reference search across all reachable files
- **Rename** — Safe rename of symbols across all references
- **Hover** — Contextual information for symbols
- **Document symbols** — Hierarchical outline of classes, state machines, states, attributes, methods
- **Code completion** — Context-aware keyword and symbol suggestions
- **Formatting** — AST-driven indent correction, arrow spacing, blank-line normalization
- **Syntax highlighting** — Tree-sitter and TextMate grammars for accurate highlighting
- **Cross-file support** — Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** — Errors in imported files shown on the `use` statement line
- **Runtime bootstrap** — Automatically downloads `umplesync.jar` on activation and offers a one-click recovery download if it is missing later

### Compile

Generate target language code from Umple source.

- **Command:** `Umple: Compile` (also accessible from the Umple menu button)
- **Target languages:** Java, PHP, Ruby, Python, C++, RT-C++, SQL
- **Status bar:** Shows the current target language (e.g., `Umple: Java`) — click to switch. Only visible when editing `.ump` files.
- **Output:** Results appear in the "Umple" output channel with parsed errors and warnings

### Diagrams

View diagrams (UML and others) generated from your Umple model.

- **Command:** `Umple: Show Diagram` or `Cmd+Shift+U` (`Ctrl+Shift+U` on Windows/Linux)
- **9 diagram types** in a dropdown selector:
  - UML Class Diagram
  - Class + Trait Diagram
  - Entity-Relationship Diagram (equivalent to the class diagram)
  - UML State Machine Diagram (if any state machines are present)
  - Feature Diagram (if any mixsets are specified and activated with a [require statement](https://cruise.umple.org/umple/RequireStatement.html))
  - UML Instance Diagram (random; each time it is generated, different instances appear)
  - State Tables (equivalent content to the state machine diagram, but different format)
  - Event Sequence (random; each time it is generated a new sequence is created)
  - Metrics
- **Click-to-select:** Click classes, traits, interfaces, states, or transitions in the diagram to jump to their source location
- **Layout engine:** Choose between dot, circo, neato, fdp, and osage (configurable via `umple.diagramLayout` setting or the in-panel dropdown)
- **Diagram filter:** Filter diagram content by class/trait name, matching UmpleOnline filter syntax
- **Zoom controls:** +/−/Fit/1:1 buttons and Ctrl/Cmd+scroll wheel (20%–500%)
- **Export:** Save as SVG or PNG
- **Live auto-refresh:** Diagrams update automatically as you edit (1.5s debounce)
- **Theme-aware:** Diagram colors adapt to your VS Code light/dark theme
- **Cross-file support:** Diagrams resolve `use` imports to include referenced files

### Snippets

Code snippets for common Umple patterns. Type the prefix and press `Tab`:

| Prefix | Description |
|--------|-------------|
| `class` | Class with attributes |
| `sm` | State machine skeleton |
| `assoc` | Inline association |
| `isa` | Inheritance (`isA`) |
| `interface` | Interface block |
| `trait` | Trait block |
| `enum` | Enum attribute |
| `use` | Use (import) statement |

### Umple Menu Button

An Umple logo button appears in the editor title bar when editing `.ump` files. Click it to access:

- Compile (with current target language)
- Show Diagram
- Change Target Language

## Requirements

- **Node.js 18+**
- **Java 11+** (optional — only needed for diagnostics, compilation, and diagrams)

## Installation

Install from the [VS Code Marketplace](https://marketplace.visualstudio.com/items?itemName=digized.umple), or build from source:

```bash
git clone https://github.com/umple/umple.vscode.git
cd umple.vscode
npm install      # automatically downloads umple-lsp-server from npm
npm run compile
```

To package as `.vsix`:

```bash
npx @vscode/vsce package
```

## Configuration

| Setting | Type | Default | Description |
|---------|------|---------|-------------|
| `umple.autoUpdate` | boolean | `true` | Automatically update umplesync.jar on startup |
| `umple.generateLanguage` | string | `"Java"` | Target language for code generation (Java, Php, Ruby, Python, Cpp, RTCpp, Sql) |
| `umple.diagramLayout` | string | `"dot"` | Layout engine for diagram rendering (dot, circo, neato, fdp, osage) |

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Show Diagram |

## Development

To test local changes to the LSP server:

1. Clone both repos side by side:

```
workspace/
├── umple-lsp/       # LSP server monorepo
└── umple.vscode/    # This extension
```

2. Build the server:

```bash
cd umple-lsp
npm install
npm run compile
```

3. Link the local server into the extension:

```bash
cd umple.vscode
npm install
npm link ../umple-lsp/packages/server
npm run compile
```

4. Press **F5** in VS Code to launch the Extension Development Host.

5. After making changes to the server, recompile and reload:

```bash
cd umple-lsp
npm run compile
```

Then in the dev host: `Cmd+Shift+P` (or `Ctrl+Shift+P`) → **Developer: Reload Window**

## Architecture

This extension is a thin client that launches the [Umple LSP server](https://github.com/umple/umple-lsp). The server handles all language intelligence (diagnostics, completion, go-to-definition, references, rename, hover, formatting). The extension adds VS Code-specific features: compile command, diagram panel, snippets, and UI chrome.

```
VS Code Extension (this repo)
  |
  +-- (stdio) --> umple-lsp-server --> umplesync.jar (diagnostics)
  |                 |
  |                 +-- tree-sitter (go-to-def, completion, references,
  |                                  rename, hover, formatting, symbols)
  |
  +-- Compile command --> umplesync.jar -generate <lang>
  |
  +-- Diagram panel --> umplesync.jar -generate GvClassDiagram/...
  |                       |
  |                       +-- @viz-js/viz (DOT → SVG rendering)
  |
  +-- Click-to-select --> umple/resolveStateLocation (custom LSP request)
                          umple/resolveTransitionLocation
```
