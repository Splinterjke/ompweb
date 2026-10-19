import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createJiti } from "jiti";

// Doc 16 route 9 parity: the Rust files service (crates/ompweb-host) must
// produce the same list/read/meta output the Node route semantics produce.
// Node side uses the extracted pure implementations (lib/directory-listing.ts,
// lib/file-language.ts); Rust side runs via the CLI parity modes.

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const hostBin = join(root, "crates", "target", "debug", "ompweb-host");

const jiti = createJiti(import.meta.url, { tsconfigPaths: true });
const { listDirectoryEntries } = await jiti.import("./directory-listing.ts");
const { getLanguage: nodeLanguage } = await jiti.import("./file-language.ts");
const { readTextFilePage } = await jiti.import("./file-read-page.ts");

function fixture() {
  const dir = join(tmpdir(), `omp-files-parity-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  mkdirSync(join(dir, "alpha-dir"), { recursive: true });
  mkdirSync(join(dir, "sub"), { recursive: true });
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  mkdirSync(join(dir, ".git"), { recursive: true });
  writeFileSync(join(dir, "a.log"), "aaa");
  writeFileSync(join(dir, "b.txt"), "hello world");
  writeFileSync(join(dir, "main.ts"), "export const x: number = 1;");
  writeFileSync(join(dir, "x.pyc"), "pyc");
  return dir;
}

function hostJson(args) {
  return JSON.parse(execFileSync(hostBin, args, { encoding: "utf8" }));
}

/** Node-side paged read shaped exactly like the host's read JSON response. */
function nodeReadPage(file, offset = 0, limit = 256 * 1024) {
  const size = statSync(file).size;
  return { ...readTextFilePage(file, size, offset, limit), language: nodeLanguage(file), size };
}

test("files parity: directory listing matches Node exactly", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  const rust = hostJson(["--files-list", dir]);
  const node = listDirectoryEntries(dir);
  assert.deepEqual(rust, node);
});

test("files parity: all=true lifts the ignore filter identically", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  const rust = hostJson(["--files-list", dir, "all"]);
  const node = listDirectoryEntries(dir, true);
  assert.deepEqual(rust, node);
  const names = rust.map((e) => e.name);
  assert.ok(names.includes("node_modules") && names.includes(".git") && names.includes("x.pyc"));
});

test("files parity: text read (paged content/language/size) matches Node", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  const file = join(dir, "main.ts");
  const rust = hostJson(["--files-read", file]);
  assert.deepEqual(rust, nodeReadPage(file));
  assert.equal(rust.truncated, false);
});

test("files parity: special language names (Dockerfile/.env/Makefile)", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  for (const [name, lang] of [["Dockerfile", "dockerfile"], [".env", "bash"], ["Makefile", "makefile"]]) {
    const file = join(dir, name);
    writeFileSync(file, "x");
    const rust = hostJson(["--files-read", file]);
    assert.equal(rust.language, lang, name);
    assert.equal(rust.language, nodeLanguage(file), name);
  }
});

test("files parity: paged reads match Node (truncation, offsets, UTF-8 boundaries)", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  const big = join(dir, "big.log");
  writeFileSync(big, Buffer.alloc(256 * 1024 + 1, 0x61));
  // >256 KiB is a truncated page now, never a rejection.
  const rustFirst = hostJson(["--files-read", big]);
  assert.deepEqual(rustFirst, nodeReadPage(big));
  assert.equal(rustFirst.truncated, true);
  const rustRest = hostJson(["--files-read", big, String(rustFirst.nextOffset)]);
  assert.deepEqual(rustRest, nodeReadPage(big, rustFirst.nextOffset));
  assert.equal(rustRest.truncated, false);

  // Tiny odd pages over multi-byte text: no page may split a character, and
  // the chained pages must reassemble the exact file text — in BOTH engines.
  const utf = join(dir, "utf.txt");
  writeFileSync(utf, Buffer.from("é€a日本語b".repeat(8), "utf8"));
  let offset = 0;
  let text = "";
  for (let page = 0; page < 80; page++) {
    const rust = hostJson(["--files-read", utf, String(offset), "3"]);
    assert.deepEqual(rust, nodeReadPage(utf, offset, 3), `page ${page} @${offset}`);
    text += rust.content;
    if (!rust.truncated) break;
    assert.ok(rust.nextOffset > offset, `page ${page} must advance`);
    offset = rust.nextOffset;
  }
  assert.equal(text, readFileSync(utf, "utf8"));
});

test("files parity: meta (mime/previewKind) matches Node tables", { skip: !existsSync(hostBin) ? "ompweb-host binary not built" : false }, () => {
  const dir = fixture();
  for (const [name, mime, previewKind] of [
    ["a.svg", "image/svg+xml", null],
    ["b.mp4", "video/mp4", null],
    ["doc.pdf", "application/pdf", "pdf"],
    ["paper.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "docx"],
  ]) {
    const file = join(dir, name);
    writeFileSync(file, "x");
    const rust = hostJson(["--files-meta", file]);
    assert.equal(rust.mime, mime, name);
    assert.equal(rust.previewKind, previewKind, name);
  }
});