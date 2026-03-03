import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";

let panel: vscode.WebviewPanel | undefined;
let debounceTimer: ReturnType<typeof setTimeout> | undefined;
let vizInstance: any = null;
let lastFilePath: string | undefined;

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
  serverDir: string
): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("umple.showDiagram", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "umple") {
        vscode.window.showWarningMessage("Open an Umple file first.");
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
        panel.webview.html = getWebviewHtml(panel.webview);
        panel.onDidDispose(() => {
          panel = undefined;
          lastFilePath = undefined;
        });
        panel.webview.onDidReceiveMessage(async (msg) => {
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

  // Re-generate diagram on save
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!panel || doc.languageId !== "umple") return;
      lastFilePath = doc.uri.fsPath;
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        updateDiagram(doc.uri.fsPath, serverDir);
      }, 500);
    })
  );
}

const DIAGRAM_TYPES = [
  { key: "class", generator: "GvClassDiagram" },
  { key: "classTrait", generator: "GvClassTraitDiagram" },
  { key: "er", generator: "GvEntityRelationshipDiagram" },
  { key: "state", generator: "GvStateDiagram" },
  { key: "feature", generator: "GvFeatureDiagram" },
] as const;

async function updateDiagram(
  filePath: string,
  serverDir: string
): Promise<void> {
  if (!panel) return;

  const jarPath = path.join(serverDir, "umplesync.jar");

  // Run umplesync in a temp directory to avoid .gv files in the user's folder
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-diagram-"));
  const tmpFile = path.join(tmpDir, path.basename(filePath));
  fs.copyFileSync(filePath, tmpFile);

  try {
    const dotResults = await Promise.all(
      DIAGRAM_TYPES.map((d) => runUmplesync(jarPath, d.generator, tmpFile))
    );

    const viz = await getViz();
    const svgs: Record<string, string> = {};

    for (let i = 0; i < DIAGRAM_TYPES.length; i++) {
      const dot = dotResults[i];
      if (dot) {
        try {
          svgs[DIAGRAM_TYPES[i].key] = viz.renderString(dot, { format: "svg", engine: "dot" });
        } catch {
          svgs[DIAGRAM_TYPES[i].key] = "";
        }
      } else {
        svgs[DIAGRAM_TYPES[i].key] = "";
      }
    }

    panel.webview.postMessage({ type: "svg", svgs });
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

function runUmplesync(
  jarPath: string,
  generate: string,
  filePath: string
): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "java",
      ["-jar", jarPath, "-generate", generate, filePath],
      { timeout: 15000, maxBuffer: 10 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          resolve(null);
        } else {
          resolve(stdout);
        }
      }
    );
  });
}

function getWebviewHtml(webview: vscode.Webview): string {
  const nonce = getNonce();
  const csp = `default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} data: blob:;`;

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
    color: var(--vscode-descriptionForeground);
    font-style: italic;
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
  </div>
  <div class="toolbar">
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

    const TAB_KEYS = ["class", "classTrait", "er", "state", "feature"];

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
      });
    });

    // Receive pre-rendered SVG from extension
    window.addEventListener("message", (event) => {
      const msg = event.data;
      if (msg.type !== "svg") return;
      TAB_KEYS.forEach(k => {
        renderSvg("diagram-" + k, msg.svgs[k] || "");
      });
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

    const TAB_LABELS = { class: "ClassDiagram", classTrait: "ClassTraitDiagram", er: "ERDiagram", state: "StateMachine", feature: "FeatureDiagram" };

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
  </script>
</body>
</html>`;
}
