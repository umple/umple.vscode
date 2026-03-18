# Umple for VS Code

A VS Code extension for the [Umple](https://www.umple.org) modeling language. Provides IDE features for `.ump` files.

As this is updated, versions will be published on the VSCode MarketPlace (there may be a delay in that happening, so you can choose to load it directly as indicated below)

## Features

### Language Intelligence (via LSP)

- **Diagnostics** — Real-time error and warning detection via the Umple compiler
- **Go-to-definition** — Jump to classes, interfaces, traits, enums, attributes, methods, state machines, states, associations, mixsets, and requirements
- **Code completion** — Context-aware keyword and symbol suggestions
- **Syntax highlighting** — Tree-sitter and TextMate grammars for accurate highlighting
- **Cross-file support** — Transitive `use` statement resolution and cross-file diagnostics
- **Import error reporting** — Errors in imported files shown on the `use` statement line
- **Runtime bootstrap** — Automatically downloads `umplesync.jar` on activation and offers a one-click recovery download if it is missing later

### Compile

Generate target language code from Umple source.

- **Command:** `Umple: Compile` (also accessible from the Umple menu button)
- **Target languages:** Java, PHP, Ruby, Python, C++, RT-C++, SQL
- **Status bar:** Shows the current target language (e.g., `Umple: Java`) — click to switch
- **Output:** Results appear in the "Umple" output channel with parsed errors and warnings

### UML Diagrams

View UML diagrams generated from your Umple model.

- **Command:** `Umple: Show UML Diagram` or `Cmd+Shift+U` (`Ctrl+Shift+U` on Windows/Linux)
- **5 diagram types** in a tabbed panel:
  - Class Diagram
  - Class + Trait Diagram
  - Entity-Relationship Diagram
  - State Machine Diagram
  - Feature Diagram
- **Zoom controls:** +/−/Fit/1:1 buttons and Ctrl/Cmd+scroll wheel (20%–500%)
- **Export:** Save as SVG or PNG
- **Auto-refresh:** Diagrams update automatically when the file is saved
- **Theme-aware:** Diagram colors adapt to your VS Code light/dark theme

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
- Show UML Diagram
- Change Target Language

## Requirements

- **Node.js 18+**
- **Java 11+** (optional — only needed for diagnostics, compilation, and diagrams)

## Installation

Install from the VS Code Marketplace (coming soon), or build from source:

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

## Keyboard Shortcuts

| Shortcut | Command |
|----------|---------|
| `Cmd+Shift+U` / `Ctrl+Shift+U` | Show UML Diagram |

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

This extension is a thin client that launches the [Umple LSP server](https://github.com/umple/umple-lsp). The server handles diagnostics, completion, and go-to-definition. The extension adds VS Code-specific features: compile command, diagram panel, snippets, and UI chrome.

```
VS Code Extension (this repo)
  |
  +-- (stdio) --> umple-lsp-server --> umplesync.jar (diagnostics)
  |                 |
  |                 +-- tree-sitter (go-to-def, completion, symbol indexing)
  |
  +-- Compile command --> umplesync.jar -generate <lang>
  |
  +-- Diagram panel --> umplesync.jar -generate GvClassDiagram/...
                          |
                          +-- @viz-js/viz (DOT → SVG rendering)
```
