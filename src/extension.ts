import * as path from "path";
import * as vscode from "vscode";
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from "vscode-languageclient/node";
import {
  checkJava,
  ensureUmpleSyncJar,
  updateUmpleSyncJar,
} from "./utils/umpleSync";
import { registerCompileCommand } from "./commands/compile";
import { registerDiagramCommand } from "./commands/diagram";

let client: LanguageClient | undefined;
let languageStatusBar: vscode.StatusBarItem | undefined;

/** Get the language client for custom LSP requests (used by diagram click-to-select). */
export function getLanguageClient(): LanguageClient | undefined {
  return client;
}

const GENERATE_LANGUAGES = ["Java", "Php", "Ruby", "Python", "Cpp", "RTCpp", "Sql"];

function updateLanguageStatusBar(): void {
  if (!languageStatusBar) return;
  const lang = vscode.workspace
    .getConfiguration("umple")
    .get<string>("generateLanguage", "Java");
  languageStatusBar.text = `Umple: ${lang}`;
  languageStatusBar.tooltip = "Click to change Umple target language";
}

// Start the client with server side attached
export async function activate(
  context: vscode.ExtensionContext,
): Promise<void> {
  // Resolve server package directory
  const serverDir = path.dirname(
    require.resolve("umple-lsp-server/package.json"),
  );

  // Check for Java — only needed for diagnostics, not for completion/go-to-def
  const hasJava = checkJava();
  if (!hasJava) {
    vscode.window.showWarningMessage(
      "Java not found. Umple diagnostics, compilation, and diagrams are disabled. Install Java 11+ and restart VS Code to enable them.",
    );
  }

  // Update umplesync.jar if needed (downloads into server package dir).
  await updateUmpleSyncJar(serverDir);

  const serverModule = require.resolve("umple-lsp-server/out/server.js");

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.stdio },
    debug: {
      module: serverModule,
      transport: TransportKind.stdio,
      options: { execArgv: ["--nolazy", "--inspect=6009"] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: "file", language: "umple" }],
    initializationOptions: {
      umpleSyncJarPath: path.join(serverDir, "umplesync.jar"),
      umpleSyncPort: 5556,
    },
    synchronize: {
      fileEvents: vscode.workspace.createFileSystemWatcher("**/*.ump"),
    },
  };

  client = new LanguageClient(
    "umpleLanguageServer",
    "Umple Language Server",
    serverOptions,
    clientOptions,
  );

  client.start();

  const restartClientAfterJarDownload = async (): Promise<void> => {
    if (!client) {
      return;
    }
    try {
      await client.restart();
    } catch (error) {
      console.error("Failed to restart the Umple language client:", error);
      vscode.window.showWarningMessage(
        "umplesync.jar was downloaded, but the Umple language server could not be restarted automatically. Reload the VS Code window if diagnostics do not return.",
      );
    }
  };

  const ensureJarAvailable = async (
    message: string,
    passive = false,
  ): Promise<boolean> =>
    ensureUmpleSyncJar(serverDir, {
      passive,
      message,
      onDownloaded: restartClientAfterJarDownload,
    });

  // Register extension commands
  registerCompileCommand(context, serverDir, ensureJarAvailable);
  registerDiagramCommand(context, serverDir, ensureJarAvailable);

  // Umple menu button (single entry point in editor title bar)
  context.subscriptions.push(
    vscode.commands.registerCommand("umple.menu", async () => {
      const lang = vscode.workspace
        .getConfiguration("umple")
        .get<string>("generateLanguage", "Java");
      const picked = await vscode.window.showQuickPick(
        [
          { label: `$(play) Compile (${lang})`, id: "compile" },
          { label: "$(type-hierarchy) Show Diagram", id: "diagram" },
          { label: "$(symbol-enum) Change Target Language", id: "language" },
        ],
        { placeHolder: "Umple" }
      );
      if (!picked) return;
      switch (picked.id) {
        case "compile":
          vscode.commands.executeCommand("umple.compile");
          break;
        case "diagram":
          vscode.commands.executeCommand("umple.showDiagram");
          break;
        case "language":
          vscode.commands.executeCommand("umple.selectLanguage");
          break;
      }
    })
  );

  // Language picker command
  context.subscriptions.push(
    vscode.commands.registerCommand("umple.selectLanguage", async () => {
      const picked = await vscode.window.showQuickPick(GENERATE_LANGUAGES, {
        placeHolder: "Select target language for Umple compilation",
      });
      if (picked) {
        await vscode.workspace
          .getConfiguration("umple")
          .update("generateLanguage", picked, vscode.ConfigurationTarget.Global);
        updateLanguageStatusBar();
      }
    })
  );

  // Status bar: target language indicator
  languageStatusBar = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Right,
    100
  );
  languageStatusBar.command = "umple.selectLanguage";
  context.subscriptions.push(languageStatusBar);
  updateLanguageStatusBar();

  // Show/hide status bar based on active editor language
  const updateVisibility = () => {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === "umple") {
      languageStatusBar!.show();
    } else {
      languageStatusBar!.hide();
    }
  };
  updateVisibility();
  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor(updateVisibility)
  );

  const promptForMissingJarIfNeeded = async (
    document: vscode.TextDocument | undefined,
  ): Promise<void> => {
    if (document?.languageId !== "umple") {
      return;
    }
    await ensureJarAvailable(
      "Umple diagnostics need umplesync.jar, but it is missing. Download it now?",
      true,
    );
  };

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      void promptForMissingJarIfNeeded(editor?.document);
    }),
  );
  context.subscriptions.push(
    vscode.workspace.onDidOpenTextDocument((document) => {
      void promptForMissingJarIfNeeded(document);
    }),
  );

  if (vscode.window.activeTextEditor?.document.languageId === "umple") {
    void promptForMissingJarIfNeeded(vscode.window.activeTextEditor.document);
  } else {
    const openUmpleDocument = vscode.workspace.textDocuments.find(
      (document) => document.languageId === "umple",
    );
    if (openUmpleDocument) {
      void promptForMissingJarIfNeeded(openUmpleDocument);
    }
  }

  // Update status bar when setting changes
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("umple.generateLanguage")) {
        updateLanguageStatusBar();
      }
    })
  );
}

export function deactivate(): Thenable<void> | undefined {
  if (!client) {
    return undefined;
  }

  return client.dispose();
}
