import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import { checkJava } from "../utils/umpleSync";
import { collectReachableUmpFiles, materializeTempWorkspace } from "./diagramWorkspace";
import { getLanguageClient } from "../extension";

let panel: vscode.WebviewPanel | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let vizInstance: any = null;
let lastFilePath: string | undefined;
let lastGoodSvgs: Record<string, string> = {};
let lastGoodFilePath: string | undefined;
let lastFilter = "*";

// Parse filter input using UmpleOnline tokenization rules (compiler.php:152-209)
const GV_SUBOPTIONS = new Set([
  "gvneato", "gvspring", "gvfdp", "gvsfdp", "gvcirco",
  "gvtwopi", "gvdot", "gvortho", "gvpolyline",
  "gvdeoverlapscale", "gvdeoverlaportho", "gvdeoverlapprism",
]);

function parseFilterInput(input: string): { filterDirective: string; suboptions: string[] } {
  const tokens = input.split(/\s+/).filter(t => t);
  const filterParts: string[] = [];
  const suboptions: string[] = [];
  const mixsets: string[] = [];

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      filterParts.push(`hops { association ${token}; }`);
    } else if (token.startsWith("gvseparator=")) {
      suboptions.push(token);
    } else if (GV_SUBOPTIONS.has(token)) {
      suboptions.push(token);
    } else if (token.startsWith("mixset")) {
      mixsets.push(`use ${token.slice(6)};`);
    } else if (token.startsWith("filter")) {
      filterParts.push(`includeFilter ${token.slice(6)};`);
    } else if (token.startsWith("gv")) {
      // unrecognized gv* — ignore
    } else if (token) {
      filterParts.push(`include ${token};`);
    }
  }

  let directive = mixsets.join(" ");
  if (filterParts.length > 0) {
    directive += ` filter { ${filterParts.join(" ")} }`;
  }
  return { filterDirective: directive.trim(), suboptions };
}

// Single source of truth for layout engine options
const LAYOUT_ENGINES = [
  { value: "dot", label: "dot (hierarchical)" },
  { value: "circo", label: "circo (circular)" },
  { value: "neato", label: "neato (spring)" },
  { value: "fdp", label: "fdp (force-directed)" },
  { value: "osage", label: "osage (clustered)" },
] as const;

function getNonce(): string {
  return crypto.randomBytes(16).toString("hex");
}

async function getViz(): Promise<any> {
  if (!vizInstance) {
    const Viz = await import("@viz-js/viz");
    vizInstance = await Viz.instance();
  }
  return vizInstance;
}

export function registerDiagramCommand(
  context: vscode.ExtensionContext,
  serverDir: string,
  ensureJarAvailable: (promptMessage: string, passive?: boolean) => Promise<boolean>,
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("umple.showDiagram", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "umple") {
        vscode.window.showWarningMessage("Open an Umple file first.");
        return;
      }

      if (!checkJava()) {
        vscode.window.showWarningMessage(
          "Java 11+ is required to generate Umple diagrams.",
        );
        return;
      }

      const jarReady = await ensureJarAvailable(
        "Diagram generation requires umplesync.jar, but it is missing. Download it now?",
      );
      if (!jarReady) {
        return;
      }

      await editor.document.save();
      lastFilePath = editor.document.uri.fsPath;

      if (panel) {
        panel.reveal(vscode.ViewColumn.Two);
      } else {
        panel = vscode.window.createWebviewPanel(
          "umpleDiagram",
          "Umple Diagram",
          vscode.ViewColumn.Two,
          { enableScripts: true, retainContextWhenHidden: true }
        );
        const currentEngine = vscode.workspace.getConfiguration("umple").get<string>("diagramLayout", "dot");
        panel.webview.html = getWebviewHtml(panel.webview, currentEngine);
        panel.onDidDispose(() => {
          panel = undefined;
          lastFilePath = undefined;
          lastGoodSvgs = {};
          lastGoodFilePath = undefined;
        });
        panel.webview.onDidReceiveMessage(async (msg) => {
          if (msg.type === "selectClass" && msg.name && lastFilePath) {
            const escapedName = msg.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
            const regex = new RegExp(`^\\s*(?:associationClass|class|interface|trait)\\s+(${escapedName})\\b`, "m");
            const doc = await vscode.workspace.openTextDocument(lastFilePath);
            const match = regex.exec(doc.getText());
            if (match) {
              const startPos = doc.positionAt(match.index + match[0].indexOf(match[1]));
              const endPos = doc.positionAt(match.index + match[0].indexOf(match[1]) + match[1].length);
              await vscode.window.showTextDocument(doc, {
                selection: new vscode.Range(startPos, endPos),
                viewColumn: vscode.ViewColumn.One,
              });
            }
            return;
          }
          if (msg.type === "selectState" && msg.className && msg.stateMachine && msg.statePath && lastFilePath) {
            const lspClient = getLanguageClient();
            if (lspClient) {
              const uri = vscode.Uri.file(lastFilePath).toString();
              try {
                const result = await lspClient.sendRequest<{ uri: string; range: { start: { line: number; character: number }; end: { line: number; character: number } } } | null>(
                  "umple/resolveStateLocation",
                  { uri, className: msg.className, stateMachine: msg.stateMachine, statePath: msg.statePath },
                );
                if (result) {
                  const doc = await vscode.workspace.openTextDocument(vscode.Uri.parse(result.uri));
                  const startPos = new vscode.Position(result.range.start.line, result.range.start.character);
                  const endPos = new vscode.Position(result.range.end.line, result.range.end.character);
                  await vscode.window.showTextDocument(doc, {
                    selection: new vscode.Range(startPos, endPos),
                    viewColumn: vscode.ViewColumn.One,
                  });
                }
              } catch {
                // LSP request failed — no-op
              }
            }
            return;
          }
          if (msg.type === "layoutChange" && msg.engine) {
            // Persist to settings — onDidChangeConfiguration will handle re-render
            await vscode.workspace.getConfiguration("umple")
              .update("diagramLayout", msg.engine, vscode.ConfigurationTarget.Global);
            return;
          }
          if (msg.type === "filterChange") {
            lastFilter = msg.filter ?? "*";
            if (lastFilePath) {
              const doc = vscode.workspace.textDocuments.find(
                d => d.uri.fsPath === lastFilePath && d.languageId === "umple"
              );
              if (doc?.isDirty) {
                void updateDiagram(lastFilePath!, serverDir, doc.getText());
              } else {
                void updateDiagram(lastFilePath!, serverDir);
              }
            }
            return;
          }
          if (msg.type !== "save") return;
          const defaultName = `${path.basename(lastFilePath || "diagram", ".ump")}_${msg.tab}`;
          if (msg.format === "svg") {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(path.dirname(lastFilePath || ""), `${defaultName}.svg`)),
              filters: { "SVG Image": ["svg"] },
            });
            if (uri) {
              await vscode.workspace.fs.writeFile(uri, Buffer.from(msg.data, "utf-8"));
              vscode.window.showInformationMessage(`Saved ${path.basename(uri.fsPath)}`);
            }
          } else if (msg.format === "png") {
            const uri = await vscode.window.showSaveDialog({
              defaultUri: vscode.Uri.file(path.join(path.dirname(lastFilePath || ""), `${defaultName}.png`)),
              filters: { "PNG Image": ["png"] },
            });
            if (uri) {
              const base64 = msg.data.replace(/^data:image\/png;base64,/, "");
              await vscode.workspace.fs.writeFile(uri, Buffer.from(base64, "base64"));
              vscode.window.showInformationMessage(`Saved ${path.basename(uri.fsPath)}`);
            }
          }
        });

      }

      await updateDiagram(lastFilePath, serverDir);
    })
  );

  // Live-regenerate diagram on edit (debounced, no auto-save — uses temp file)
  context.subscriptions.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!panel || e.document.languageId !== "umple") return;
      if (e.document.uri.fsPath !== lastFilePath) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (!checkJava()) return;
        const jarReady = await ensureJarAvailable(
          "Diagram generation requires umplesync.jar, but it is missing. Download it now?",
          true,
        );
        if (!jarReady) return;
        // Pass editor content directly — no disk save needed
        await updateDiagram(e.document.uri.fsPath, serverDir, e.document.getText());
      }, 1500);
    })
  );

  // Also regenerate on save (from disk, covers external changes)
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!panel || doc.languageId !== "umple") return;
      if (doc.uri.fsPath !== lastFilePath) return;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(async () => {
        if (!checkJava()) return;
        const jarReady = await ensureJarAvailable(
          "Diagram generation requires umplesync.jar, but it is missing. Download it now?",
          true,
        );
        if (!jarReady) return;
        await updateDiagram(doc.uri.fsPath, serverDir);
      }, 500);
    })
  );

  // Re-render when diagram settings change (e.g., layout engine) + sync dropdown
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (!panel || !lastFilePath) return;
      if (e.affectsConfiguration("umple.diagramLayout")) {
        const engine = vscode.workspace.getConfiguration("umple").get<string>("diagramLayout", "dot");
        panel.webview.postMessage({ type: "setLayout", engine });
        // Use in-memory content if editor is dirty (preserves live-preview state)
        const doc = vscode.workspace.textDocuments.find(
          d => d.uri.fsPath === lastFilePath && d.languageId === "umple"
        );
        if (doc?.isDirty) {
          updateDiagram(lastFilePath!, serverDir, doc.getText());
        } else {
          updateDiagram(lastFilePath!, serverDir);
        }
      }
    })
  );
}

// ── Diagram types ────────────────────────────────────────────────────────────

type DiagramType = { key: string; label: string; generator: string; format: "dot" | "html" };

const DIAGRAM_TYPES: DiagramType[] = [
  { key: "class", label: "Class Diagram", generator: "GvClassDiagram", format: "dot" },
  { key: "classTrait", label: "Class + Trait", generator: "GvClassTraitDiagram", format: "dot" },
  { key: "er", label: "ER Diagram", generator: "GvEntityRelationshipDiagram", format: "dot" },
  { key: "state", label: "State Machine", generator: "GvStateDiagram", format: "dot" },
  { key: "feature", label: "Feature Diagram", generator: "GvFeatureDiagram", format: "dot" },
  { key: "instance", label: "Instance Diagram", generator: "instanceDiagram", format: "dot" },
  { key: "stateTables", label: "State Tables", generator: "StateTables", format: "html" },
  { key: "eventSequence", label: "Event Sequence", generator: "EventSequence", format: "html" },
  { key: "metrics", label: "Metrics", generator: "SimpleMetrics", format: "html" },
];

async function updateDiagram(
  filePath: string,
  serverDir: string,
  content?: string,
): Promise<void> {
  if (!panel) return;

  const jarPath = path.join(serverDir, "umplesync.jar");

  // Build temp workspace with reachable use-closure (handles cross-directory imports)
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-diagram-"));
  const { files: reachableFiles, truncated } = collectReachableUmpFiles(filePath, content);
  if (truncated) {
    console.warn("Diagram: import closure exceeded limit, some imports may be missing");
  }
  const tmpFile = materializeTempWorkspace(tmpDir, filePath, content, reachableFiles);

  try {
    // Parse filter input into -u and -s args
    const { filterDirective, suboptions } = parseFilterInput(lastFilter);

    const results = await Promise.all(
      DIAGRAM_TYPES.map((d) => runUmplesync(jarPath, d.generator, tmpFile, d.format === "html", filterDirective, suboptions))
    );

    // Clear cache if the source file changed
    if (filePath !== lastGoodFilePath) {
      lastGoodSvgs = {};
      lastGoodFilePath = filePath;
    }

    const viz = await getViz();
    const engine = vscode.workspace.getConfiguration("umple").get<string>("diagramLayout", "dot");
    const svgs: Record<string, string> = {};
    let anyFailed = false;

    for (let i = 0; i < DIAGRAM_TYPES.length; i++) {
      const key = DIAGRAM_TYPES[i].key;
      const format = DIAGRAM_TYPES[i].format;
      const output = results[i];

      if (format === "html") {
        // HTML-based diagrams: strip <script> tags, send plain HTML
        if (output) {
          const html = output.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "");
          svgs[key] = html;
          lastGoodSvgs[key] = html;
        } else {
          svgs[key] = lastGoodSvgs[key] || "";
          anyFailed = true;
        }
      } else {
        // Dot-based diagrams: render through Viz.js
        if (output) {
          try {
            const svg = viz.renderString(output, { format: "svg", engine });
            svgs[key] = svg;
            lastGoodSvgs[key] = svg;
          } catch {
            svgs[key] = lastGoodSvgs[key] || "";
            anyFailed = true;
          }
        } else {
          svgs[key] = lastGoodSvgs[key] || "";
          anyFailed = true;
        }
      }
    }

    panel.webview.postMessage({ type: "svg", svgs, stale: anyFailed });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runUmplesync(
  jarPath: string,
  generate: string,
  filePath: string,
  expectHtml = false,
  filterDirective = "",
  suboptions: string[] = [],
): Promise<string | null> {
  return new Promise((resolve) => {
    const args = ["-jar", jarPath, "-generate", generate, filePath];
    if (filterDirective) args.push("-u", filterDirective);
    for (const sub of suboptions) args.push("-s", sub);
    execFile(
      "java",
      args,
      { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
        } else if (expectHtml) {
          // HTML generators: any non-trivial output is valid
          const trimmed = stdout?.trim();
          resolve(trimmed && trimmed !== "null" && trimmed.length > 10 ? trimmed : null);
        } else {
          // Dot generators: must contain digraph
          resolve(stdout && /^\s*digraph\b/m.test(stdout) ? stdout : null);
        }
      }
    );
  });
}

function getWebviewHtml(webview: vscode.Webview, currentEngine: string): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;`;

  const layoutOptions = LAYOUT_ENGINES.map(e =>
    `<option value="${e.value}"${e.value === currentEngine ? " selected" : ""}>${e.label}</option>`
  ).join("\n      ");

  const diagramTypeOptions = DIAGRAM_TYPES.map(d =>
    `<option value="${d.key}">${d.label}</option>`
  ).join("\n      ");

  const diagramTypeData = JSON.stringify(DIAGRAM_TYPES.map(d => ({
    key: d.key, label: d.label, format: d.format,
  })));

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: var(--vscode-font-family);
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
    overflow: hidden;
    height: 100vh;
    display: flex;
    flex-direction: column;
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 4px 12px;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-tab-inactiveBackground);
    font-size: 12px;
    color: var(--vscode-descriptionForeground);
  }
  .toolbar input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, #454545);
    padding: 2px 6px;
    font-size: 12px;
    border-radius: 3px;
  }
  .toolbar input[type="text"]::placeholder {
    color: var(--vscode-input-placeholderForeground);
  }
  .toolbar select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 2px 6px;
    font-size: 12px;
    border-radius: 3px;
    cursor: pointer;
  }
  .toolbar button {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
    border: none;
    padding: 2px 8px;
    cursor: pointer;
    font-size: 13px;
    border-radius: 3px;
  }
  .toolbar button:hover {
    background: var(--vscode-button-secondaryHoverBackground);
  }
  .toolbar .zoom-level {
    min-width: 40px;
    text-align: center;
  }
  .diagram-container {
    flex: 1;
    overflow: auto;
    padding: 16px;
  }
  .diagram-wrapper {
    transform-origin: top center;
    display: inline-block;
    min-width: 100%;
    text-align: center;
  }
  .diagram-container svg {
    display: inline-block;
  }
  .empty, .loading {
    text-align: center;
    padding-top: 40px;
  }
  .html-diagram-content {
    background: #fff;
    color: #1e1e1e;
    padding: 12px;
    font-family: sans-serif;
    font-size: 13px;
    overflow-x: auto;
    position: relative;
    text-align: left;
  }
  .html-diagram-content h1 { font-size: 16px; margin: 8px 0; }
  .html-diagram-content h2 { font-size: 14px; margin: 6px 0; }
  .html-diagram-content h3 { font-size: 13px; margin: 4px 0; }
  .stale-banner {
    padding: 12px 16px;
    color: var(--vscode-descriptionForeground, #999);
    font-style: italic;
    font-size: 13px;
  }
</style>
</head>
<body>
  <div class="toolbar">
    <select id="diagram-type-select" title="Diagram type">
      ${diagramTypeOptions}
    </select>
    <span style="width:12px"></span>
    <select id="layout-select" title="Layout engine">
      ${layoutOptions}
    </select>
    <span style="width:12px"></span>
    <input id="filter-input" type="text" value="*" placeholder="Filter (e.g., Person* ~Order 2)" title="You can choose to display a subset of classes by naming them, separated by spaces.&#10;&#10;You can use glob wildcards to specify patterns matching several classes.&#10;So * matches any number of characters in a class name and ? matches any single character.&#10;&#10;Preceding a pattern with a ~ indicates to skip classes matching the pattern.&#10;&#10;Superclasses of any selected classes will always also appear (even if ~ is used).&#10;&#10;The above is a shortcut for including a filter directive in the code using the notation filter {include Classpattern;}&#10;Filters in the code will take precedence.&#10;&#10;No class pattern starting with 'gv' can be used as these match the suboptions below.&#10;&#10;You can also use an integer such as 1 or 2 to also add classes that are connected by an association 1 or 2 (or any number of) hops away from selected classes.&#10;&#10;You can also widen (or narrow) the spacing of nodes by using an expression like gvseparator=1.7, where 1.0 is the default spacing.&#10;&#10;Press Enter to apply." style="width:180px;" />
    <span style="width:12px"></span>
    <button id="zoom-out" title="Zoom out">−</button>
    <span id="zoom-level" class="zoom-level">100%</span>
    <button id="zoom-in" title="Zoom in">+</button>
    <button id="zoom-fit" title="Fit to view">Fit</button>
    <button id="zoom-reset" title="Reset to 100%">1:1</button>
    <span style="flex:1"></span>
    <button id="save-svg" title="Save as SVG">Save SVG</button>
    <button id="save-png" title="Save as PNG">Save PNG</button>
  </div>
  <div id="diagram-class" class="diagram-container">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-classTrait" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-er" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-state" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-feature" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-instance" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating diagram...</div></div>
  </div>
  <div id="diagram-stateTables" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating...</div></div>
  </div>
  <div id="diagram-eventSequence" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating...</div></div>
  </div>
  <div id="diagram-metrics" class="diagram-container" style="display:none">
    <div class="diagram-wrapper"><div class="loading">Generating...</div></div>
  </div>
  <div id="offscreen-stage" style="position:absolute;top:0;left:0;visibility:hidden;pointer-events:none;z-index:-1;overflow:hidden;"></div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let currentTab = "class";
    let zoom = 1;
    const ZOOM_STEP = 0.15;
    const ZOOM_MIN = 0.2;
    const ZOOM_MAX = 5;

    function updateZoom() {
      document.querySelectorAll(".diagram-wrapper").forEach(w => {
        w.style.transform = "scale(" + zoom + ")";
      });
      document.getElementById("zoom-level").textContent = Math.round(zoom * 100) + "%";
    }

    // Layout engine dropdown
    document.getElementById("layout-select").addEventListener("change", (e) => {
      vscode.postMessage({ type: "layoutChange", engine: e.target.value });
    });

    // Filter input — triggers on Enter/blur (change event), same as UmpleOnline
    document.getElementById("filter-input").addEventListener("change", (e) => {
      vscode.postMessage({ type: "filterChange", filter: e.target.value });
    });

    // SVG click-to-select: intercept class and state clicks in diagrams
    document.addEventListener("click", function(e) {
      // Find the closest <a> — works for both HTML and SVG anchors
      var el = e.target;
      while (el && el.tagName !== "a" && el.tagName !== "A" && el.localName !== "a") {
        el = el.parentElement;
      }
      if (!el) return;
      var href = el.getAttributeNS("http://www.w3.org/1999/xlink", "href")
        || el.getAttribute("xlink:href")
        || el.getAttribute("href")
        || "";

      // Class clicks: Action.selectClass("Person")
      var classMatch = href.match(/Action\\.selectClass\\("([^"]+)"\\)/);
      if (classMatch) {
        e.preventDefault();
        vscode.postMessage({ type: "selectClass", name: classMatch[1] });
        return;
      }

      // State clicks: Action.stateClicked("Light^*^status^*^Off")
      var stateMatch = href.match(/Action\\.stateClicked\\("([^"]+)"\\)/);
      if (stateMatch) {
        e.preventDefault();
        // Parse ^*^ delimited payload: [className, stateMachine, stateName...]
        var parts = stateMatch[1].split("^*^");
        if (parts.length >= 3) {
          var className = parts[0];
          var stateMachine = parts[1];
          // Last part may be dotted (e.g., "Outer.Done")
          var stateStr = parts.slice(2).join(".");
          var statePath = stateStr.split(".");
          vscode.postMessage({ type: "selectState", className: className, stateMachine: stateMachine, statePath: statePath });
        }
      }
    });

    document.getElementById("zoom-in").addEventListener("click", () => {
      zoom = Math.min(ZOOM_MAX, zoom + ZOOM_STEP);
      updateZoom();
    });
    document.getElementById("zoom-out").addEventListener("click", () => {
      zoom = Math.max(ZOOM_MIN, zoom - ZOOM_STEP);
      updateZoom();
    });
    document.getElementById("zoom-reset").addEventListener("click", () => {
      zoom = 1;
      updateZoom();
    });
    document.getElementById("zoom-fit").addEventListener("click", () => {
      const container = document.querySelector(".diagram-container:not([style*='display: none'])") ||
                        document.querySelector(".diagram-container");
      const svg = container.querySelector("svg");
      if (!svg) return;
      const svgW = svg.getBoundingClientRect().width / zoom;
      const svgH = svg.getBoundingClientRect().height / zoom;
      const cW = container.clientWidth - 32;
      const cH = container.clientHeight - 32;
      zoom = Math.min(cW / svgW, cH / svgH, ZOOM_MAX);
      zoom = Math.max(zoom, ZOOM_MIN);
      updateZoom();
    });

    // Ctrl/Cmd + scroll to zoom
    document.addEventListener("wheel", (e) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        if (e.deltaY < 0) {
          zoom = Math.min(ZOOM_MAX, zoom + ZOOM_STEP);
        } else {
          zoom = Math.max(ZOOM_MIN, zoom - ZOOM_STEP);
        }
        updateZoom();
      }
    }, { passive: false });

    // Diagram types — generated from DIAGRAM_TYPES on the extension side
    const DIAGRAM_DATA = ${diagramTypeData};
    const TAB_KEYS = DIAGRAM_DATA.map(d => d.key);
    const HTML_TABS = new Set(DIAGRAM_DATA.filter(d => d.format === "html").map(d => d.key));

    // Diagram type switching via dropdown
    function switchDiagramType(newType) {
      currentTab = newType;
      TAB_KEYS.forEach(k => {
        document.getElementById("diagram-" + k).style.display =
          k === currentTab ? "" : "none";
      });
      // Re-run Event Sequence formatter on activation
      if (NEEDS_FORMATTER.has(currentTab)) {
        requestAnimationFrame(function() {
          var content = document.querySelector("#diagram-" + currentTab + " .html-diagram-content");
          if (content) formatEventSequenceGrid(content);
        });
      }
      // Hide save buttons for HTML tabs
      var isHtml = HTML_TABS.has(currentTab);
      document.getElementById("save-svg").style.display = isHtml ? "none" : "";
      document.getElementById("save-png").style.display = isHtml ? "none" : "";
    }

    document.getElementById("diagram-type-select").addEventListener("change", function(e) {
      switchDiagramType(e.target.value);
    });

    // Receive messages from extension
    window.addEventListener("message", (event) => {
      const msg = event.data;
      // Sync layout dropdown when setting changes from outside
      if (msg.type === "setLayout" && msg.engine) {
        document.getElementById("layout-select").value = msg.engine;
        return;
      }
      if (msg.type !== "svg") return;
      TAB_KEYS.forEach(k => {
        if (HTML_TABS.has(k)) {
          renderHtml("diagram-" + k, msg.svgs[k] || "");
        } else {
          renderSvg("diagram-" + k, msg.svgs[k] || "");
        }
      });
      // Show/remove stale banner inside each diagram container after the SVG
      document.querySelectorAll(".stale-banner").forEach(el => el.remove());
      if (msg.stale) {
        TAB_KEYS.forEach(k => {
          var container = document.getElementById("diagram-" + k);
          var banner = document.createElement("div");
          banner.className = "stale-banner";
          banner.textContent = "Diagram may be out of date \u2014 current code has errors.";
          container.appendChild(banner);
        });
      }
    });

    function renderSvg(containerId, svgString) {
      const container = document.getElementById(containerId);
      const wrapper = container.querySelector(".diagram-wrapper");
      if (!svgString || !svgString.trim()) {
        wrapper.innerHTML = '<div class="empty">No diagram available</div>';
        return;
      }
      wrapper.innerHTML = svgString;
      const svg = wrapper.querySelector("svg");
      if (svg) {
        recolorSvg(svg);
      }
      updateZoom();
    }

    // Generation guard — prevents stale async callbacks from applying
    var renderGeneration = {};

    // Scoped, re-entrant Event Sequence layout formatter
    function formatEventSequenceGrid(container) {
      var wrappers = container.querySelectorAll(".event-sequence-grid .wrapper");
      for (var w = 0; w < wrappers.length; w++) {
        var wrapper = wrappers[w];
        var columnHeaders = wrapper.querySelectorAll(".column-header");
        if (!columnHeaders.length) continue;

        var tableBody = wrapper.querySelector(".table-body");
        var floatingCol = wrapper.querySelector(".floating-col");
        var innerWrapper = wrapper.querySelector(".inner-wrapper");
        var actualTable = innerWrapper ? innerWrapper.querySelector("table") : null;
        if (!tableBody || !floatingCol || !innerWrapper || !actualTable) continue;

        // Clear previous inline styles for clean re-measurement
        tableBody.style.height = "";
        innerWrapper.style.width = "";
        actualTable.style.top = "";
        actualTable.style.left = "";
        floatingCol.style.top = "";
        floatingCol.style.left = "";

        // Measure from clean baseline
        var longest = 0, last = 0;
        for (var i = 0; i < columnHeaders.length; i++) {
          var span = columnHeaders[i].querySelector("div > span");
          if (!span) continue;
          if (span.offsetWidth > longest) longest = span.offsetWidth;
          if (i === columnHeaders.length - 1) last = span.offsetWidth;
        }

        var spacerHeight = longest * Math.cos(45 * Math.PI / 180);
        var lastLabelWidth = last * Math.sin(45 * Math.PI / 180);

        tableBody.style.height = (tableBody.offsetHeight + spacerHeight) + "px";
        innerWrapper.style.width = (floatingCol.offsetWidth + actualTable.offsetWidth + lastLabelWidth) + "px";
        actualTable.style.top = spacerHeight + "px";
        floatingCol.style.top = (spacerHeight - 1) + "px";
        actualTable.style.left = (floatingCol.offsetWidth - 6) + "px";
        floatingCol.style.left = "0px";
      }
    }

    var NEEDS_FORMATTER = new Set(["eventSequence"]);

    function renderHtml(containerId, htmlString) {
      var container = document.getElementById(containerId);
      var wrapper = container.querySelector(".diagram-wrapper");
      if (!htmlString || !htmlString.trim()) {
        wrapper.innerHTML = '<div class="empty">No content available</div>';
        return;
      }

      var htmlContainer = document.createElement("div");
      htmlContainer.className = "html-diagram-content";
      htmlContainer.innerHTML = htmlString;

      // Determine the tab key from containerId (e.g., "diagram-eventSequence" -> "eventSequence")
      var tabKey = containerId.replace("diagram-", "");

      if (NEEDS_FORMATTER.has(tabKey)) {
        // Use offscreen staging for Event Sequence (needs DOM measurement)
        var gen = (renderGeneration[containerId] || 0) + 1;
        renderGeneration[containerId] = gen;

        var stage = document.getElementById("offscreen-stage");
        // Size stage to match the real target container width
        var visibleContainer = document.querySelector(".diagram-container:not([style*='display: none'])");
        var targetWidth = container.clientWidth || (visibleContainer ? visibleContainer.clientWidth : 600);
        stage.style.width = targetWidth + "px";
        stage.replaceChildren();
        stage.appendChild(htmlContainer);

        // Double rAF: first ensures DOM attached, second ensures layout computed
        requestAnimationFrame(function() {
          requestAnimationFrame(function() {
            if (renderGeneration[containerId] !== gen) return; // stale
            formatEventSequenceGrid(htmlContainer);
            // Move from staging into the real tab container
            wrapper.replaceChildren();
            wrapper.style.transform = "none";
            wrapper.appendChild(htmlContainer);
            stage.replaceChildren();
          });
        });
      } else {
        // Simple HTML tabs (StateTables, Metrics) — direct injection, no staging
        wrapper.replaceChildren();
        wrapper.style.transform = "none";
        wrapper.appendChild(htmlContainer);
      }
    }

    const TAB_LABELS = {};
    DIAGRAM_DATA.forEach(function(d) { TAB_LABELS[d.key] = d.label.replace(/\s+/g, ""); });

    document.getElementById("save-svg").addEventListener("click", () => {
      const container = document.getElementById("diagram-" + currentTab);
      const svg = container.querySelector("svg");
      if (!svg) return;
      const svgData = new XMLSerializer().serializeToString(svg);
      vscode.postMessage({ type: "save", format: "svg", data: svgData, tab: TAB_LABELS[currentTab] });
    });

    document.getElementById("save-png").addEventListener("click", () => {
      const container = document.getElementById("diagram-" + currentTab);
      const svg = container.querySelector("svg");
      if (!svg) return;
      // Render SVG to canvas, then export as PNG data URL
      const svgData = new XMLSerializer().serializeToString(svg);
      const svgBlob = new Blob([svgData], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(svgBlob);
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth * 2;
        canvas.height = img.naturalHeight * 2;
        const ctx = canvas.getContext("2d");
        ctx.scale(2, 2);
        ctx.drawImage(img, 0, 0);
        URL.revokeObjectURL(url);
        const pngDataUrl = canvas.toDataURL("image/png");
        vscode.postMessage({ type: "save", format: "png", data: pngDataUrl, tab: TAB_LABELS[currentTab] });
      };
      img.src = url;
    });

    function recolorSvg(svg) {
      const fg = getComputedStyle(document.body).getPropertyValue('color');
      const bg = getComputedStyle(document.body).getPropertyValue('background-color');

      // Recolor background polygon (the large graph background)
      const bgPolygon = svg.querySelector(':scope > g > polygon');
      if (bgPolygon) bgPolygon.setAttribute('fill', 'transparent');

      // Recolor all text
      svg.querySelectorAll('text').forEach(t => t.setAttribute('fill', fg));

      // Recolor lines, borders, arrows
      svg.querySelectorAll('path, line').forEach(el => {
        if (el.getAttribute('stroke') && el.getAttribute('stroke') !== 'none') {
          el.setAttribute('stroke', fg);
        }
      });
      svg.querySelectorAll('polygon').forEach(p => {
        const fill = p.getAttribute('fill');
        const stroke = p.getAttribute('stroke');
        if (fill === 'black') p.setAttribute('fill', fg);
        if (stroke === 'black') p.setAttribute('stroke', fg);
        if (fill === 'white' || fill === '#ffffff') p.setAttribute('fill', bg);
      });
      svg.querySelectorAll('ellipse').forEach(e => {
        const fill = e.getAttribute('fill');
        const stroke = e.getAttribute('stroke');
        if (fill === 'black') e.setAttribute('fill', fg);
        if (stroke === 'black') e.setAttribute('stroke', fg);
      });
    }

    // Re-run Event Sequence formatter on panel resize
    new ResizeObserver(function() {
      if (NEEDS_FORMATTER.has(currentTab)) {
        var content = document.querySelector("#diagram-" + currentTab + " .html-diagram-content");
        if (content) formatEventSequenceGrid(content);
      }
    }).observe(document.body);
  </script>
</body>
</html>`;
}
