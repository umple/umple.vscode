import * as fs from "fs";
import * as path from "path";

export const MAX_IMPORTED_FILES = 100;
const USE_FILE_REGEX = /^\s*use\s+([^"\s;][^;]*?\.ump)\s*;?\s*$/gm;

/**
 * Extract unquoted `use X.ump;` file import paths from Umple source text.
 * Ignores quoted use, mixset use, and non-.ump forms.
 */
export function extractFileUsePaths(text: string): string[] {
  const paths: string[] = [];
  let match;
  USE_FILE_REGEX.lastIndex = 0;
  while ((match = USE_FILE_REGEX.exec(text)) !== null) {
    const p = match[1].trim();
    if (p && !paths.includes(p)) paths.push(p);
  }
  return paths;
}

/**
 * Collect the reachable use-closure from an entry file.
 * Follows unquoted `use X.ump` imports recursively.
 * Cycle-safe via visited set. Bounded by MAX_IMPORTED_FILES.
 */
export function collectReachableUmpFiles(
  entryFile: string,
  entryContent?: string,
): { files: Set<string>; truncated: boolean } {
  const visited = new Set<string>();
  const queue: Array<{ file: string; content?: string }> = [
    { file: path.resolve(entryFile), content: entryContent },
  ];
  let truncated = false;

  while (queue.length > 0) {
    if (visited.size >= MAX_IMPORTED_FILES) { truncated = true; break; }
    const item = queue.shift()!;
    const absPath = item.file;
    if (visited.has(absPath)) continue;
    visited.add(absPath);

    let text: string;
    if (item.content !== undefined) {
      text = item.content;
    } else {
      try { text = fs.readFileSync(absPath, "utf8"); } catch { continue; }
    }

    const usePaths = extractFileUsePaths(text);
    for (const usePath of usePaths) {
      const resolved = path.resolve(path.dirname(absPath), usePath);
      if (!visited.has(resolved) && fs.existsSync(resolved)) {
        queue.push({ file: resolved });
      }
    }
  }
  return { files: visited, truncated };
}

/**
 * Find the common ancestor directory of a set of file paths.
 * Uses containing directories (not file paths) to ensure result is always a directory.
 */
export function findCommonAncestor(paths: string[]): string {
  if (paths.length === 0) return "/";
  const dirs = paths.map(p => path.dirname(p));
  const parts = dirs.map(d => d.split(path.sep));
  const common: string[] = [];
  for (let i = 0; i < parts[0].length; i++) {
    const seg = parts[0][i];
    if (parts.every(p => p[i] === seg)) common.push(seg);
    else break;
  }
  return common.join(path.sep) || "/";
}

/**
 * Materialize a temp workspace with the reachable use-closure.
 * Preserves relative paths from the common ancestor.
 * If rootContent is provided, writes it instead of copying from disk.
 * Returns the temp path corresponding to the root file.
 */
export function materializeTempWorkspace(
  tmpDir: string,
  rootFile: string,
  rootContent: string | undefined,
  reachableFiles: Set<string>,
): string {
  const allPaths = Array.from(reachableFiles);
  const ancestor = findCommonAncestor(allPaths);

  for (const absFile of allPaths) {
    const relPath = path.relative(ancestor, absFile);
    const destPath = path.join(tmpDir, relPath);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    if (absFile === path.resolve(rootFile) && rootContent !== undefined) {
      fs.writeFileSync(destPath, rootContent);
    } else {
      try { fs.copyFileSync(absFile, destPath); } catch {}
    }
  }

  return path.join(tmpDir, path.relative(ancestor, path.resolve(rootFile)));
}
