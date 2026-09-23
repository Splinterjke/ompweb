import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

async function loadSubject() {
  return import("./export-vendor.ts");
}

const vendorFile = (name) => readFileSync(new URL(`../../public/vendor/${name}`, import.meta.url), "utf8");

const MARKED_TAG =
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/marked/15.0.4/marked.min.js" integrity="sha512-x" crossorigin="anonymous" referrerpolicy="no-referrer"></script>';
const HIGHLIGHT_TAG =
  '<script src="https://cdnjs.cloudflare.com/ajax/libs/highlight.js/11.9.0/highlight.min.js" integrity="sha512-y" crossorigin="anonymous"></script>';

test("replaces both CDN script tags with inlined vendor copies", async () => {
  const { inlineExportVendorScripts } = await loadSubject();

  const out = inlineExportVendorScripts(`<html><head>${MARKED_TAG}\n  ${HIGHLIGHT_TAG}</head><body></body></html>`);

  assert.doesNotMatch(out, /cdnjs\.cloudflare\.com/);
  assert.doesNotMatch(out, /integrity=/);
  assert.ok(out.includes(vendorFile("marked.min.js")), "marked source is inlined");
  assert.ok(out.includes(vendorFile("highlight.min.js")), "highlight.js source is inlined");
});

test("leaves HTML without CDN tags unchanged", async () => {
  const { inlineExportVendorScripts } = await loadSubject();

  const html = `<html><head><script src="/local/app.js"></script></head><body></body></html>`;

  assert.equal(inlineExportVendorScripts(html), html);
});

test("ignores external scripts for unknown libraries", async () => {
  const { inlineExportVendorScripts } = await loadSubject();

  const tag = '<script src="https://cdnjs.cloudflare.com/ajax/libs/lodash/4.17.21/lodash.min.js"></script>';

  assert.equal(inlineExportVendorScripts(tag), tag);
});

test("is idempotent", async () => {
  const { inlineExportVendorScripts } = await loadSubject();

  const once = inlineExportVendorScripts(`<head>${MARKED_TAG}${HIGHLIGHT_TAG}</head>`);

  assert.equal(inlineExportVendorScripts(once), once);
});
