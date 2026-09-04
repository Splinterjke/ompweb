// Pre-build cleanup: `next build` typechecks the generated route types (tsconfig
// include) but never *writes* them — only `next dev` does (in .next-dev, since
// distDir is split per mode). A crashed or hard-killed dev server can leave
// stale, half-written type files (truncated `validator.ts` / `routes.d.ts`)
// that break the next production build's "Running TypeScript" step. Remove the
// dev-only caches before building so the build never typechecks artifacts it
// is not responsible for producing. `.next/dev` is kept for repos where an
// older dev server (distDir still `.next`) already left artifacts behind.
import { rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
for (const dir of [".next-dev", ".next-dev/dev", ".next/dev", ".next/dev/dev"]) {
  rmSync(join(root, dir), { recursive: true, force: true });
}
