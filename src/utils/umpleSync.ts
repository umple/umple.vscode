import * as fs from "fs";
import * as https from "https";
import * as child_process from "child_process";
import * as path from "path";
import * as vscode from "vscode";

const UMPLESYNC_JAR_URL = "https://try.umple.org/scripts/umplesync.jar";
const UMPLE_VERSION_URL =
  "https://cruise.umple.org/umpleonline/scripts/versionRunning.txt";

type EnsureUmpleSyncJarOptions = {
  passive?: boolean;
  message?: string;
  onDownloaded?: () => Promise<void> | void;
};

let downloadInFlight: Promise<boolean> | undefined;
let ensureInFlight: Promise<boolean> | undefined;
let passivePromptDismissed = false;

/**
 * Check if Java is available on the system.
 */
export function checkJava(): boolean {
  try {
    child_process.execSync("java -version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Extract semantic version from full Umple version string.
 * "1.35.0.7523.c616a4dce" -> "1.35.0"
 */
function extractSemanticVersion(fullVersion: string): string {
  const parts = fullVersion.split(".");
  if (parts.length >= 3) {
    return parts.slice(0, 3).join(".");
  }
  return fullVersion;
}

/**
 * Get the current version of umplesync.jar.
 */
export function getCurrentVersion(jarPath: string): string | null {
  if (!fs.existsSync(jarPath)) {
    return null;
  }
  try {
    const output = child_process
      .execSync(`java -jar "${jarPath}" -version`, { encoding: "utf8" })
      .trim();
    // Extract version from output like "Version: 1.35.0.7523.c616a4dce"
    const match = output.match(/Version:\s*(.+)/i);
    const fullVersion = match ? match[1].trim() : output;
    return extractSemanticVersion(fullVersion);
  } catch {
    return null;
  }
}

/**
 * Follow redirects and fetch content from an HTTPS URL with a timeout.
 */
function httpsGet(url: string, timeoutMs = 60000): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        httpsGet(res.headers.location, timeoutMs).then(resolve, reject);
        return;
      }
      if (res.statusCode && res.statusCode !== 200) {
        reject(new Error(`HTTP ${res.statusCode}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.on("timeout", () => {
      req.destroy(new Error(`Request timed out after ${timeoutMs}ms`));
    });
  });
}

/**
 * Get the latest version number from Umple server.
 */
export async function getLatestVersion(): Promise<string | null> {
  try {
    const buf = await httpsGet(UMPLE_VERSION_URL);
    const output = buf.toString("utf8").trim();
    if (!output) return null;
    return extractSemanticVersion(output);
  } catch {
    return null;
  }
}

/**
 * Download a file using curl (handles proxies, certs better than Node https).
 */
function curlDownload(url: string, dest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    child_process.execFile("curl", ["-fSL", "-o", dest, url], { timeout: 60000 }, (err) => {
      if (err) { reject(err); } else { resolve(); }
    });
  });
}

/**
 * Clean up a temp file, ignoring errors if it doesn't exist.
 */
function cleanupTempFile(tempPath: string): void {
  try { fs.unlinkSync(tempPath); } catch { /* ignore */ }
}

/**
 * Download umplesync.jar from the Umple server, retrying up to 3 times.
 * Tries curl first (better proxy/cert handling), falls back to Node.js https.
 * Downloads to a temp file and atomically renames on success to prevent corrupt jars.
 */
export async function downloadUmpleSyncJar(jarPath: string): Promise<boolean> {
  const tempPath = jarPath + ".tmp";
  const attempts = 3;
  for (let i = 1; i <= attempts; i++) {
    // Primary: curl (available on macOS, most Linux, Windows 10+)
    try {
      await curlDownload(UMPLESYNC_JAR_URL, tempPath);
      fs.renameSync(tempPath, jarPath);
      return true;
    } catch (curlError) {
      cleanupTempFile(tempPath);
      console.error(`Failed to download umplesync.jar via curl (attempt ${i}/${attempts}):`, curlError);
    }
    // Fallback: Node.js https (works even if curl is not installed)
    try {
      const buf = await httpsGet(UMPLESYNC_JAR_URL);
      fs.writeFileSync(tempPath, buf);
      fs.renameSync(tempPath, jarPath);
      return true;
    } catch (error) {
      cleanupTempFile(tempPath);
      console.error(`https fallback also failed (attempt ${i}/${attempts}):`, error);
    }
    if (i < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
    }
  }
  return false;
}

export function getUmpleSyncJarPath(serverDir: string): string {
  return path.join(serverDir, "umplesync.jar");
}

export function hasUmpleSyncJar(serverDir: string): boolean {
  return fs.existsSync(getUmpleSyncJarPath(serverDir));
}

/**
 * Download umplesync.jar with a progress notification.
 * Used by updateUmpleSyncJar for the no-prompt auto-download path.
 * Deduplicates concurrent calls via downloadInFlight.
 */
async function downloadWithProgress(
  serverDir: string,
  title: string,
): Promise<boolean> {
  const jarPath = getUmpleSyncJarPath(serverDir);
  if (fs.existsSync(jarPath)) {
    passivePromptDismissed = false;
    return true;
  }

  if (downloadInFlight) {
    return downloadInFlight;
  }

  downloadInFlight = Promise.resolve(
    vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title,
        cancellable: false,
      },
      async () => {
        const ok = await downloadUmpleSyncJar(jarPath);
        if (ok) {
          passivePromptDismissed = false;
        }
        return ok;
      },
    ),
  );

  try {
    const inFlight = downloadInFlight;
    return inFlight ? await inFlight : false;
  } finally {
    downloadInFlight = undefined;
  }
}

/**
 * Ensure umplesync.jar is available. If missing, prompts the user to download
 * it with retry-on-failure UI. Deduplicates concurrent calls. Supports passive
 * mode (dismissable once per session) for background prompts.
 */
export async function ensureUmpleSyncJar(
  serverDir: string,
  options: EnsureUmpleSyncJarOptions = {},
): Promise<boolean> {
  if (hasUmpleSyncJar(serverDir)) {
    passivePromptDismissed = false;
    return true;
  }

  if (options.passive && passivePromptDismissed) {
    return false;
  }

  if (ensureInFlight) {
    return ensureInFlight;
  }

  ensureInFlight = (async () => {
    while (true) {
      const choice = await vscode.window.showWarningMessage(
        options.message ?? "umplesync.jar is missing. Download it now?",
        "Download",
        "Not Now",
      );

      if (choice !== "Download") {
        if (options.passive) {
          passivePromptDismissed = true;
        }
        return false;
      }

      // User explicitly chose to download — clear passive dismissal
      passivePromptDismissed = false;

      const jarPath = getUmpleSyncJarPath(serverDir);
      const ok = await Promise.resolve(
        vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Downloading umplesync.jar...",
            cancellable: false,
          },
          async () => downloadUmpleSyncJar(jarPath),
        ),
      );

      if (ok) {
        passivePromptDismissed = false;
        await options.onDownloaded?.();
        return true;
      }

      // Download failed — offer retry
      const retry = await vscode.window.showWarningMessage(
        "Failed to download umplesync.jar.",
        "Retry",
        "Cancel",
      );
      if (retry !== "Retry") {
        return false;
      }
      // Loop back to show the Download/Not Now prompt again
    }
  })();

  try {
    return await ensureInFlight;
  } finally {
    ensureInFlight = undefined;
  }
}

/**
 * Update umplesync.jar if a newer version is available.
 */
export async function updateUmpleSyncJar(serverDir: string): Promise<void> {
  const config = vscode.workspace.getConfiguration("umple");
  if (!config.get("autoUpdate")) {
    return;
  }

  const jarPath = getUmpleSyncJarPath(serverDir);

  // Check if JAR exists
  if (!fs.existsSync(jarPath)) {
    const ok = await downloadWithProgress(
      serverDir,
      "Downloading umplesync.jar...",
    );
    if (!ok) {
      const choice = await vscode.window.showWarningMessage(
        "Failed to download umplesync.jar. Diagnostics, compilation, and diagrams will stay unavailable until it is downloaded.",
        "Retry",
      );
      if (choice === "Retry") {
        await updateUmpleSyncJar(serverDir);
      }
    }
    return;
  }

  // Without Java we can't inspect the local JAR version reliably.
  if (!checkJava()) {
    return;
  }

  // Check for updates
  const currentVersion = getCurrentVersion(jarPath);
  const latestVersion = await getLatestVersion();

  if (!latestVersion) {
    return; // Can't check version, skip update
  }

  if (currentVersion !== latestVersion) {
    const result = await vscode.window.showInformationMessage(
      `A new version of Umple is available (${latestVersion}). Update now?`,
      "Update",
      "Later",
    );

    if (result === "Update") {
      const ok = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Updating umplesync.jar...",
          cancellable: false,
        },
        async () => downloadUmpleSyncJar(jarPath),
      );
      if (ok) {
        vscode.window.showInformationMessage("umplesync.jar updated successfully!");
      } else {
        vscode.window.showWarningMessage("Failed to update umplesync.jar. Will retry on next startup.");
      }
    }
  }
}
