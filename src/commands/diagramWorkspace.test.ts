import * as assert from "assert";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { execFileSync } from "child_process";
import {
  extractFileUsePaths,
  collectReachableUmpFiles,
  findCommonAncestor,
  materializeTempWorkspace,
} from "./diagramWorkspace";

let passed = 0;
let failed = 0;

function test(name: string, fn: () => void) {
  try {
    fn();
    passed++;
  } catch (e: any) {
    failed++;
    console.error(`  FAIL: ${name}`);
    console.error(`    ${e.message}`);
  }
}

function mkFixture(structure: Record<string, string>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "umple-test-"));
  for (const [relPath, content] of Object.entries(structure)) {
    const absPath = path.join(root, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content);
  }
  return root;
}

function cleanup(dir: string) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// Find umplesync.jar for integration tests
const JAR_PATH = path.resolve(__dirname, "..", "..", "node_modules", "umple-lsp-server", "umplesync.jar");
const hasJar = fs.existsSync(JAR_PATH);

// ── extractFileUsePaths ──────────────────────────────────────────────────────

console.log("extractFileUsePaths:");

test("basic unquoted use", () => {
  const result = extractFileUsePaths("use old.ump;\nclass A {}");
  assert.strictEqual(result.length, 1);
  assert.strictEqual(result[0], "old.ump");
});

test("quoted use ignored", () => {
  assert.strictEqual(extractFileUsePaths('use "quoted.ump";\nclass A {}').length, 0);
});

test("mixset use ignored", () => {
  assert.strictEqual(extractFileUsePaths("use FeatureX;\nclass A {}").length, 0);
});

test("duplicates removed", () => {
  assert.strictEqual(extractFileUsePaths("use a.ump;\nuse b.ump;\nuse a.ump;").length, 2);
});

test("relative path preserved", () => {
  const result = extractFileUsePaths("use ../shared/lib.ump;");
  assert.strictEqual(result[0], "../shared/lib.ump");
});

test("no use statements", () => {
  assert.strictEqual(extractFileUsePaths("class A { name; }").length, 0);
});

// ── findCommonAncestor ───────────────────────────────────────────────────────

console.log("findCommonAncestor:");

test("single file → parent dir", () => {
  assert.strictEqual(findCommonAncestor(["/tmp/test/A.ump"]), "/tmp/test");
});

test("siblings → same dir", () => {
  assert.strictEqual(findCommonAncestor(["/tmp/test/A.ump", "/tmp/test/B.ump"]), "/tmp/test");
});

test("cross-dir → common parent", () => {
  assert.strictEqual(findCommonAncestor(["/tmp/test/models/A.ump", "/tmp/test/shared/B.ump"]), "/tmp/test");
});

test("empty → root", () => {
  assert.strictEqual(findCommonAncestor([]), "/");
});

// ── collectReachableUmpFiles ─────────────────────────────────────────────────

console.log("collectReachableUmpFiles:");

test("single file, no imports", () => {
  const root = mkFixture({ "A.ump": "class A {}" });
  const { files, truncated } = collectReachableUmpFiles(path.join(root, "A.ump"));
  assert.strictEqual(files.size, 1);
  assert.strictEqual(truncated, false);
  cleanup(root);
});

test("same-directory import", () => {
  const root = mkFixture({
    "main.ump": "use helper.ump;\nclass Main {}",
    "helper.ump": "class Helper {}",
  });
  const { files } = collectReachableUmpFiles(path.join(root, "main.ump"));
  const names = Array.from(files).map(f => path.basename(f)).sort();
  assert.deepStrictEqual(names, ["helper.ump", "main.ump"]);
  cleanup(root);
});

test("parent-directory import", () => {
  const root = mkFixture({
    "models/main.ump": "use ../shared/lib.ump;\nclass Main {}",
    "shared/lib.ump": "class Lib {}",
  });
  const { files } = collectReachableUmpFiles(path.join(root, "models", "main.ump"));
  const names = Array.from(files).map(f => path.basename(f)).sort();
  assert.deepStrictEqual(names, ["lib.ump", "main.ump"]);
  cleanup(root);
});

test("import cycle terminates", () => {
  const root = mkFixture({
    "A.ump": "use B.ump;\nclass A {}",
    "B.ump": "use A.ump;\nclass B {}",
  });
  const { files } = collectReachableUmpFiles(path.join(root, "A.ump"));
  assert.strictEqual(files.size, 2);
  cleanup(root);
});

test("missing import does not crash", () => {
  const root = mkFixture({ "main.ump": "use missing.ump;\nclass Main {}" });
  const { files } = collectReachableUmpFiles(path.join(root, "main.ump"));
  assert.strictEqual(files.size, 1);
  cleanup(root);
});

test("multi-level chain", () => {
  const root = mkFixture({
    "models/top.ump": "use ../shared/mid.ump;\nclass Top {}",
    "shared/mid.ump": "use ../base/bot.ump;\nclass Mid {}",
    "base/bot.ump": "class Bot {}",
  });
  const { files } = collectReachableUmpFiles(path.join(root, "models", "top.ump"));
  const names = Array.from(files).map(f => path.basename(f)).sort();
  assert.deepStrictEqual(names, ["bot.ump", "mid.ump", "top.ump"]);
  cleanup(root);
});

test("in-memory content followed", () => {
  const root = mkFixture({ "helper.ump": "class Helper {}" });
  const { files } = collectReachableUmpFiles(path.join(root, "main.ump"), "use helper.ump;\nclass Main {}");
  const names = Array.from(files).map(f => path.basename(f));
  assert.ok(names.includes("helper.ump"), "should include helper.ump");
  cleanup(root);
});

// ── materializeTempWorkspace ─────────────────────────────────────────────────

console.log("materializeTempWorkspace:");

test("single file materializes", () => {
  const root = mkFixture({ "A.ump": "class A {}" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-tw-"));
  const { files } = collectReachableUmpFiles(path.join(root, "A.ump"));
  const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "A.ump"), undefined, files);
  assert.ok(fs.existsSync(tmpFile), "temp file should exist");
  assert.strictEqual(fs.readFileSync(tmpFile, "utf8"), "class A {}");
  cleanup(root); cleanup(tmpDir);
});

test("same-directory preserves both files", () => {
  const root = mkFixture({
    "main.ump": "use helper.ump;\nclass Main {}",
    "helper.ump": "class Helper {}",
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-tw-"));
  const { files } = collectReachableUmpFiles(path.join(root, "main.ump"));
  const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "main.ump"), undefined, files);
  assert.ok(fs.existsSync(tmpFile));
  assert.ok(fs.existsSync(path.join(path.dirname(tmpFile), "helper.ump")));
  cleanup(root); cleanup(tmpDir);
});

test("cross-directory preserves relative structure", () => {
  const root = mkFixture({
    "models/main.ump": "use ../shared/lib.ump;\nclass Main {}",
    "shared/lib.ump": "class Lib {}",
  });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-tw-"));
  const { files } = collectReachableUmpFiles(path.join(root, "models", "main.ump"));
  const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "models", "main.ump"), undefined, files);
  assert.ok(fs.existsSync(tmpFile));
  const libPath = path.resolve(path.dirname(tmpFile), "../shared/lib.ump");
  assert.ok(fs.existsSync(libPath), "lib.ump should exist at " + libPath);
  cleanup(root); cleanup(tmpDir);
});

test("in-memory content written instead of disk", () => {
  const root = mkFixture({ "A.ump": "class A { original; }" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-tw-"));
  const { files } = collectReachableUmpFiles(path.join(root, "A.ump"), "class A { edited; }");
  const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "A.ump"), "class A { edited; }", files);
  assert.strictEqual(fs.readFileSync(tmpFile, "utf8"), "class A { edited; }");
  cleanup(root); cleanup(tmpDir);
});

// ── Real-jar integration tests ───────────────────────────────────────────────

if (hasJar) {
  console.log("real-jar integration:");

  test("same-directory import: imported class appears in diagram", () => {
    const root = mkFixture({
      "main.ump": "use helper.ump;\nclass Main { isA Helper; }",
      "helper.ump": "class Helper { name; }",
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-jar-"));
    const { files } = collectReachableUmpFiles(path.join(root, "main.ump"));
    const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "main.ump"), undefined, files);
    const stdout = execFileSync("java", ["-jar", JAR_PATH, "-generate", "GvClassDiagram", tmpFile], {
      encoding: "utf8", timeout: 15000,
    });
    assert.ok(stdout.includes("Helper"), "diagram should contain Helper class");
    assert.ok(stdout.includes("Main"), "diagram should contain Main class");
    cleanup(root); cleanup(tmpDir);
  });

  test("parent-directory import: imported class appears in diagram", () => {
    const root = mkFixture({
      "models/main.ump": "use ../shared/lib.ump;\nclass Main { isA Lib; }",
      "shared/lib.ump": "class Lib { id; }",
    });
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "umple-jar-"));
    const { files } = collectReachableUmpFiles(path.join(root, "models", "main.ump"));
    const tmpFile = materializeTempWorkspace(tmpDir, path.join(root, "models", "main.ump"), undefined, files);
    const stdout = execFileSync("java", ["-jar", JAR_PATH, "-generate", "GvClassDiagram", tmpFile], {
      encoding: "utf8", timeout: 15000,
    });
    assert.ok(stdout.includes("Lib"), "diagram should contain Lib class");
    assert.ok(stdout.includes("Main"), "diagram should contain Main class");
    cleanup(root); cleanup(tmpDir);
  });
} else {
  console.log("real-jar integration: SKIPPED (umplesync.jar not found at " + JAR_PATH + ")");
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
