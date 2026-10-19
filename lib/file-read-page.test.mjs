import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readTextFilePage, parseReadWindow } from "./file-read-page.ts";

const dir = mkdtempSync(join(tmpdir(), "omp-read-page-"));

function fixture(name, bytes) {
  const file = join(dir, name);
  writeFileSync(file, Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes, "utf8"));
  return file;
}

test.after(() => rmSync(dir, { recursive: true, force: true }));

test("whole file inside the limit is one complete page", () => {
  const file = fixture("small.txt", "hello world");
  const page = readTextFilePage(file, 11, 0, 256 * 1024);
  assert.deepEqual(page, { content: "hello world", offset: 0, nextOffset: 11, truncated: false });
});

test("ASCII pages chain to the exact text", () => {
  const text = "The quick brown fox jumps over the lazy dog.";
  const file = fixture("ascii.txt", text);
  let offset = 0;
  let loaded = "";
  for (let guard = 0; guard < 100; guard++) {
    const page = readTextFilePage(file, text.length, offset, 10);
    assert.ok(page.truncated || page.nextOffset === text.length);
    loaded += page.content;
    if (!page.truncated) break;
    assert.ok(page.nextOffset > offset, "every page must advance");
    offset = page.nextOffset;
  }
  assert.equal(loaded, text);
});

test("a page never splits a multi-byte character; it completes instead", () => {
  // "aé€" = 1 + 2 + 3 bytes; a 2-byte limit must read the completing byte in.
  const file = fixture("chars.txt", "aé€");
  const first = readTextFilePage(file, 6, 0, 2);
  assert.equal(first.content, "aé");
  assert.equal(first.offset, 0);
  assert.equal(first.nextOffset, 3);
  assert.equal(first.truncated, true);
  const second = readTextFilePage(file, 6, 3, 2);
  assert.equal(second.content, "€");
  assert.equal(second.nextOffset, 6);
  assert.equal(second.truncated, false);
});

test("an offset landing inside a character starts on the next boundary", () => {
  // "éx" = [0xC3, 0xA9, 0x78]; starting at byte 1 skips the stray continuation.
  const file = fixture("mid.txt", "éx");
  const page = readTextFilePage(file, 3, 1, 16);
  assert.equal(page.content, "x");
  assert.equal(page.offset, 2);
  assert.equal(page.nextOffset, 3);
});

test("offset at or past EOF is an empty, non-truncated, idempotent page", () => {
  const file = fixture("tail.txt", "abc");
  for (const offset of [3, 99]) {
    const page = readTextFilePage(file, 3, offset, 16);
    assert.deepEqual(page, { content: "", offset: Math.min(offset, 3), nextOffset: 3, truncated: false });
  }
});

test("a corrupt all-continuation tail still advances (no paging stall)", () => {
  // Orphan continuation byte before 'A': the page skips it and reports the
  // offset of the real content instead of looping on an empty page.
  const file = fixture("corrupt.bin", Buffer.from([0xa9, 0x41]));
  const page = readTextFilePage(file, 2, 0, 1);
  assert.equal(page.nextOffset, 1);
  assert.ok(page.nextOffset > 0, "the viewer must always be able to reach EOF");
});

test("parseReadWindow defaults, clamps, and ignores garbage", () => {
  assert.deepEqual(parseReadWindow(null, null, 262144, 1048576), { offset: 0, limit: 262144 });
  assert.deepEqual(parseReadWindow("1024", "4096", 262144, 1048576), { offset: 1024, limit: 4096 });
  assert.deepEqual(parseReadWindow("abc", "-9", 262144, 1048576), { offset: 0, limit: 262144 });
  assert.deepEqual(parseReadWindow("5", "999999999", 262144, 1048576), { offset: 5, limit: 1048576 });
  assert.deepEqual(parseReadWindow("", "", 262144, 1048576), { offset: 0, limit: 262144 });
});
