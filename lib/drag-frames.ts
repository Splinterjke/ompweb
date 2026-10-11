/**
 * Iframes (the Git Graph embed, the browser tab) swallow mousemove/mouseup,
 * so ANY window/document-mousemove drag freezes the moment the pointer
 * crosses a frame. Marking the body lets globals.css turn off pointer events
 * on every iframe for the duration of the drag. Call with true on drag start
 * and false on end — including unmount cleanup paths.
 */
export function setFrameDragGuard(active: boolean): void {
  if (typeof document === "undefined") return;
  document.body.classList.toggle("omp-drag-resizing", active);
}
