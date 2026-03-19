import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import { checkJava } from "../utils/umpleSync";

let panel: vscode.WebviewPanel | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let vizInstance: any = null;
let lastFilePath: string | undefined;
let lastGoodSvgs: Record<string, string> = {};
let lastGoodFilePath: string | undefined;

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
          { enableScripts: true }
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
          if (msg.type === "layoutChange" && msg.engine) {
            // Persist to settings — onDidChangeConfiguration will handle re-render
            await vscode.workspace.getConfiguration("umple")
              .update("diagramLayout", msg.engine, vscode.ConfigurationTarget.Global);
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

type DiagramType = { key: string; generator: string; format: "dot" | "html" };

const DIAGRAM_TYPES: DiagramType[] = [
  { key: "class", generator: "GvClassDiagram", format: "dot" },
  { key: "classTrait", generator: "GvClassTraitDiagram", format: "dot" },
  { key: "er", generator: "GvEntityRelationshipDiagram", format: "dot" },
  { key: "state", generator: "GvStateDiagram", format: "dot" },
  { key: "feature", generator: "GvFeatureDiagram", format: "dot" },
  { key: "instance", generator: "instanceDiagram", format: "dot" },
  { key: "stateTables", generator: "StateTables", format: "html" },
  { key: "eventSequence", generator: "EventSequence", format: "html" },
  { key: "metrics", generator: "SimpleMetrics", format: "html" },
];

async function updateDiagram(
  filePath: string,
  serverDir: string,
  content?: string,
): Promise<void> {
  if (!panel) return;

  const jarPath = path.join(serverDir, "umplesync.jar");

  // Run umplesync in a temp directory to avoid .gv files in the user's folder
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-diagram-"));
  const tmpFile = path.join(tmpDir, path.basename(filePath));
  if (content !== undefined) {
    // Write in-memory editor content (live preview without saving)
    fs.writeFileSync(tmpFile, content);
    // Copy sibling .ump files for use-statement resolution
    const sourceDir = path.dirname(filePath);
    for (const f of fs.readdirSync(sourceDir)) {
      if (f.endsWith(".ump") && f !== path.basename(filePath)) {
        try { fs.copyFileSync(path.join(sourceDir, f), path.join(tmpDir, f)); } catch {}
      }
    }
  } else {
    fs.copyFileSync(filePath, tmpFile);
  }

  try {
    const results = await Promise.all(
      DIAGRAM_TYPES.map((d) => runUmplesync(jarPath, d.generator, tmpFile, d.format === "html"))
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
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "java",
      ["-jar", jarPath, "-generate", generate, filePath],
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
  .tabs {
    display: flex;
    border-bottom: 1px solid var(--vscode-panel-border);
    background: var(--vscode-tab-inactiveBackground);
  }
  .tab {
    padding: 8px 16px;
    cursor: pointer;
    border: none;
    background: transparent;
    color: var(--vscode-tab-inactiveForeground);
    font-size: 13px;
  }
  .tab.active {
    background: var(--vscode-tab-activeBackground);
    color: var(--vscode-tab-activeForeground);
    border-bottom: 2px solid var(--vscode-focusBorder);
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
  <div class="tabs">
    <button class="tab active" data-tab="class">Class</button>
    <button class="tab" data-tab="classTrait">Class + Trait</button>
    <button class="tab" data-tab="er">ER</button>
    <button class="tab" data-tab="state">State Machine</button>
    <button class="tab" data-tab="feature">Feature</button>
    <button class="tab" data-tab="instance">Instance</button>
    <button class="tab" data-tab="stateTables">State Tables</button>
    <button class="tab" data-tab="eventSequence">Event Sequence</button>
    <button class="tab" data-tab="metrics">Metrics</button>
  </div>
  <div class="toolbar">
    <select id="layout-select" title="Layout engine">
      ${layoutOptions}
    </select>
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

    const TAB_KEYS = ["class", "classTrait", "er", "state", "feature", "instance", "stateTables", "eventSequence", "metrics"];
    const HTML_TABS = new Set(["stateTables", "eventSequence", "metrics"]);

    // Tab switching
    document.querySelectorAll(".tab").forEach(tab => {
      tab.addEventListener("click", () => {
        document.querySelectorAll(".tab").forEach(t => t.classList.remove("active"));
        tab.classList.add("active");
        currentTab = tab.dataset.tab;
        TAB_KEYS.forEach(k => {
          document.getElementById("diagram-" + k).style.display =
            k === currentTab ? "" : "none";
        });
        // Re-run Event Sequence formatter on tab activation (measurements need visible container)
        if (NEEDS_FORMATTER.has(currentTab)) {
          requestAnimationFrame(function() {
            var content = document.querySelector("#diagram-" + currentTab + " .html-diagram-content");
            if (content) formatEventSequenceGrid(content);
          });
        }
        // Hide save buttons for HTML tabs (no SVG to export)
        var isHtml = HTML_TABS.has(currentTab);
        document.getElementById("save-svg").style.display = isHtml ? "none" : "";
        document.getElementById("save-png").style.display = isHtml ? "none" : "";
      });
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

    const TAB_LABELS = { class: "ClassDiagram", classTrait: "ClassTraitDiagram", er: "ERDiagram", state: "StateMachine", feature: "FeatureDiagram", instance: "InstanceDiagram", stateTables: "StateTables", eventSequence: "EventSequence", metrics: "Metrics" };

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
