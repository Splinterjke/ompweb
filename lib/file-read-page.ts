/**
 * Paged text reads for `GET /api/files/<path>?type=read`.
 *
 * Replaces the old hard 256 KiB preview cap: a read returns ONE byte page
 * (default `TEXT_PREVIEW_MAX_BYTES`, clamped to `TEXT_PREVIEW_MAX_PAGE_BYTES`)
 * plus the bookkeeping the viewer needs to ask for the next page. The pages
 * chain through `nextOffset`, which is always a valid UTF-8 boundary — a page
 * never starts or ends inside a multi-byte character (partial sequences are
 * trimmed off the end and re-delivered with the next page).
 *
 * The Rust mirror lives in crates/ompweb-host/src/file_service.rs
 * (`read_ungated`); lib/files-parity.test.mjs pins the two against each other.
 */
import fs from "fs";

export interface TextFilePage {
  /** Decoded page content (UTF-8, whole characters only). */
  content: string;
  /** Byte offset of the first byte of `content` (post-boundary-alignment). */
  offset: number;
  /** Byte offset where the NEXT page starts; equals `size` at EOF. */
  nextOffset: number;
  /** True while bytes remain after `nextOffset`. */
  truncated: boolean;
}

/** UTF-8 continuation byte: `10xxxxxx`. */
function isContinuation(byte: number): boolean {
  return (byte & 0xc0) === 0x80;
}

/** Total length of the UTF-8 sequence starting at `lead`; 1 for invalid leads. */
function utf8SequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if ((lead & 0xe0) === 0xc0) return 2;
  if ((lead & 0xf0) === 0xe0) return 3;
  if ((lead & 0xf8) === 0xf0) return 4;
  return 1;
}

/**
 * Bytes missing from the page's trailing character, or 0 when the page ends
 * on a character boundary. Scans back over at most 3 continuation bytes to a
 * lead byte; a page whose whole tail is continuation bytes (malformed input)
 * reports no gap and is settled by the boundary trimming below.
 */
function trailingSequenceGap(bytes: Buffer): number {
  const n = bytes.length;
  if (n === 0) return 0;
  let lead = n;
  while (lead > 0 && lead > n - 3 && isContinuation(bytes[lead - 1])) lead -= 1;
  if (lead <= 0 || lead <= n - 4) return 0;
  const have = n - (lead - 1);
  const seq = utf8SequenceLength(bytes[lead - 1]);
  return have < seq ? seq - have : 0;
}

/**
 * Read `limit` bytes at `offset` from `filePath` (whose total size is `size`),
 * snapped to UTF-8 character boundaries: pages never start or end inside a
 * multi-byte character. A page may overshoot `limit` by up to 3 bytes to
 * complete its final character; a character truncated by the real EOF (a
 * corrupt file tail) is dropped rather than half-delivered. An offset past
 * EOF yields an empty, non-truncated page (idempotent tail reads).
 */
export function readTextFilePage(
  filePath: string,
  size: number,
  offset: number,
  limit: number,
): TextFilePage {
  const start = Math.min(Math.max(offset, 0), size);
  const take = Math.max(0, Math.min(limit, size - start));

  let bytes = Buffer.alloc(0);
  if (take > 0) {
    const fd = fs.openSync(filePath, "r");
    try {
      const buffer = Buffer.alloc(take);
      let read = 0;
      while (read < take) {
        const n = fs.readSync(fd, buffer, read, take - read, start + read);
        if (n <= 0) break;
        read += n;
      }
      bytes = buffer.subarray(0, read);
      // Never split the trailing character: if its sequence is incomplete and
      // the file continues, read in the few (≤3) bytes that complete it.
      const need = trailingSequenceGap(bytes);
      if (need > 0 && start + bytes.length < size) {
        const extra = Buffer.alloc(need);
        let got = 0;
        while (got < need) {
          const n = fs.readSync(fd, extra, got, need - got, start + bytes.length + got);
          if (n <= 0) break;
          got += n;
        }
        if (got > 0) bytes = Buffer.concat([bytes, extra.subarray(0, got)]);
      }
    } finally {
      fs.closeSync(fd);
    }
  }

  // Start on a character boundary: skip leading continuation bytes.
  let begin = 0;
  while (begin < bytes.length && isContinuation(bytes[begin])) begin += 1;

  // End after a WHOLE character: if the trailing run of continuation bytes
  // belongs to a sequence whose lead byte leaves it incomplete in this page
  // (only possible at a truncated file tail after the extension read), cut
  // before the lead byte.
  let end = bytes.length;
  let lead = bytes.length;
  while (lead > begin && isContinuation(bytes[lead - 1])) lead -= 1;
  if (lead > begin && bytes.length - (lead - 1) < utf8SequenceLength(bytes[lead - 1])) {
    end = lead - 1;
  }
  if (end < begin) end = begin;
  // Last-resort progress guard: a page that would decode to nothing while
  // bytes were read (corrupt all-continuation tails) still advances, so the
  // viewer can always reach EOF.
  if (end === begin && bytes.length > begin) end = bytes.length;

  const content = bytes.subarray(begin, end).toString("utf8");
  const alignedOffset = start + begin;
  const nextOffset = alignedOffset + (end - begin);
  return {
    content,
    offset: alignedOffset,
    nextOffset,
    truncated: nextOffset < size,
  };
}

/** Parse `?offset=`/`?limit=` into a safe read window (defaults + clamps). */
export function parseReadWindow(
  rawOffset: string | null,
  rawLimit: string | null,
  defaultLimit: number,
  maxLimit: number,
): { offset: number; limit: number } {
  const parsedOffset = Number(rawOffset ?? "");
  const offset = Number.isFinite(parsedOffset) && parsedOffset > 0 ? Math.floor(parsedOffset) : 0;
  const parsedLimit = Number(rawLimit ?? "");
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0
    ? Math.min(Math.floor(parsedLimit), maxLimit)
    : defaultLimit;
  return { offset, limit };
}
