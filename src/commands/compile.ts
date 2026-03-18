import * as vscode from "vscode";
import { execFile } from "child_process";
import * as path from "path";
import { checkJava } from "../utils/umpleSync";

type UmpleResult = {
  errorCode?: string;
  severity?: string;
  message?: string;
  line?: string;
  filename?: string;
  url?: string;
};

/**
 * Parse umplesync JSON output and return structured errors/warnings.
 * Umplesync outputs `{ "results": [...] }` to stdout even on failure (exit 0).
 * Severity: 0-2 = error, 3+ = warning.
 */
function parseUmpleOutput(stdout: string): {
  errors: UmpleResult[];
  warnings: UmpleResult[];
} {
  const errors: UmpleResult[] = [];
  const warnings: UmpleResult[] = [];

  // Find JSON in stdout (umplesync may print other text before/after)
  const jsonMatch = stdout.match(/\{[\s\S]*"results"[\s\S]*\}/);
  if (!jsonMatch) return { errors, warnings };

  try {
    const sanitized = jsonMatch[0].replace(/\\'/g, "'");
    const parsed = JSON.parse(sanitized) as { results?: UmpleResult[] };
    if (!Array.isArray(parsed.results)) return { errors, warnings };

    for (const r of parsed.results) {
      const sev = Number(r.severity ?? "3");
      if (sev <= 2) {
        errors.push(r);
      } else {
        warnings.push(r);
      }
    }
  } catch {
    // Not valid JSON — ignore
  }

  return { errors, warnings };
}

function formatResult(r: UmpleResult): string {
  const prefix =
    Number(r.severity ?? "3") <= 2
      ? `E${r.errorCode ?? ""}`
      : `W${r.errorCode ?? ""}`;
  const loc = r.filename ? `${r.filename}:${r.line ?? "?"}` : "";
  return loc
    ? `  ${loc}: ${prefix}: ${r.message ?? ""}`
    : `  ${prefix}: ${r.message ?? ""}`;
}

export function registerCompileCommand(
  context: vscode.ExtensionContext,
  serverDir: string,
  ensureJarAvailable: (promptMessage: string, passive?: boolean) => Promise<boolean>,
): void {
  const outputChannel = vscode.window.createOutputChannel("Umple");

  context.subscriptions.push(
    vscode.commands.registerCommand("umple.compile", async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor || editor.document.languageId !== "umple") {
        vscode.window.showWarningMessage("Open an Umple file first.");
        return;
      }

      if (!checkJava()) {
        vscode.window.showWarningMessage(
          "Java 11+ is required to compile Umple models.",
        );
        return;
      }

      const jarReady = await ensureJarAvailable(
        "Compilation requires umplesync.jar, but it is missing. Download it now?",
      );
      if (!jarReady) {
        return;
      }

      await editor.document.save();

      const filePath = editor.document.uri.fsPath;
      const jarPath = path.join(serverDir, "umplesync.jar");
      const lang = vscode.workspace
        .getConfiguration("umple")
        .get<string>("generateLanguage", "Java");

      outputChannel.clear();
      outputChannel.show(true);
      outputChannel.appendLine(
        `Compiling ${path.basename(filePath)} → ${lang}...`,
      );

      execFile(
        "java",
        ["-jar", jarPath, "-generate", lang, filePath],
        {
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024,
          cwd: path.dirname(filePath),
        },
        (error, stdout, stderr) => {
          if (error && error.killed) {
            outputChannel.appendLine("Compilation timed out.");
            vscode.window.showErrorMessage("Umple: Compilation timed out.");
            return;
          }

          if (error) {
            if (stderr) outputChannel.appendLine(stderr);
            outputChannel.appendLine(
              `Compilation failed (exit code ${error.code}).`,
            );
            vscode.window.showErrorMessage("Umple: Compilation failed.");
            return;
          }

          // umplesync outputs error JSON to stderr (stdout is just "null")
          const { errors, warnings } = parseUmpleOutput(stderr);

          if (errors.length > 0) {
            outputChannel.appendLine(
              `${errors.length} error(s), ${warnings.length} warning(s):`,
            );
            for (const e of errors) outputChannel.appendLine(formatResult(e));
            for (const w of warnings) outputChannel.appendLine(formatResult(w));
            outputChannel.appendLine("Compilation failed.");
            vscode.window.showErrorMessage(
              `Umple: ${errors.length} error(s). See Output for details.`,
            );
          } else if (warnings.length > 0) {
            outputChannel.appendLine(`${warnings.length} warning(s):`);
            for (const w of warnings) outputChannel.appendLine(formatResult(w));
            outputChannel.appendLine("Compilation succeeded with warnings.");
            vscode.window.showWarningMessage(
              `Umple: Generated ${lang} code with ${warnings.length} warning(s).`,
            );
          } else {
            outputChannel.appendLine("Compilation succeeded.");
            vscode.window.showInformationMessage(
              `Umple: Generated ${lang} code.`,
            );
          }
        },
      );
    }),
  );
}
