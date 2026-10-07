"use client";
import { useMemo, useState } from "react";
import { Tooltip } from "./ui/primitives";
import { useI18n } from "@/lib/i18n";
import { CodeBlock } from "./MermaidBlock";
import { ZoomDialog } from "./ZoomDialog";

interface SvgBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}

/** Strip an XML prologue / leading comments and require an `<svg>` root. */
export function svgRootMarkup(code: string): string | null {
  let text = code.trim();
  for (;;) {
    if (text.startsWith("<?xml")) {
      const end = text.indexOf("?>");
      if (end < 0) return null;
      text = text.slice(end + 2).trim();
      continue;
    }
    if (text.startsWith("<!--")) {
      const end = text.indexOf("-->");
      if (end < 0) return null;
      text = text.slice(end + 3).trim();
      continue;
    }
    break;
  }
  return /^<svg(\s|>)/i.test(text) ? text : null;
}

function utf8ToBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
  }
  return btoa(binary);
}

/**
 * SVG code fence with an image preview, mirroring MermaidBlock's
 * source/preview toggle. The preview renders through a data-URI `<img>`:
 * browsers never execute scripts inside image-loaded SVGs, so agent-
 * generated markup is inert without an HTML sanitizer.
 */
export function SvgBlock({ code, isStreaming, defaultPreview = false }: SvgBlockProps) {
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [zoomOpen, setZoomOpen] = useState(false);
  const previewVisible = showPreview && !isStreaming;

  const dataUri = useMemo(() => {
    if (!previewVisible) return undefined;
    const markup = svgRootMarkup(code);
    if (!markup) return undefined;
    return `data:image/svg+xml;base64,${utf8ToBase64(markup)}`;
  }, [code, previewVisible]);

  const previewButton = (
    <Tooltip content={isStreaming ? t("svgBlock.previewAfterStreaming") : (previewVisible ? t("svgBlock.showSourceTitle") : t("svgBlock.previewTitle"))}>
      <button
        type="button"
        onClick={() => setShowPreview((v) => !v)}
        disabled={isStreaming}
        aria-label={isStreaming ? t("svgBlock.previewAfterStreaming") : (previewVisible ? t("svgBlock.showSourceTitle") : t("svgBlock.previewTitle"))}
        className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
      >
        {previewVisible ? t("svgBlock.source") : t("svgBlock.preview")}
      </button>
    </Tooltip>
  );

  if (!previewVisible) {
    return <CodeBlock code={code} lang="svg" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body = dataUri === undefined ? (
    <div className="mermaid-block mermaid-block-error">
      <span>{t("svgBlock.invalidSvg")}</span>
    </div>
  ) : (
    <>
      {!zoomOpen && (
        <Tooltip content={t("svgBlock.openViewer")}>
          <button
            type="button"
            className="mermaid-block mermaid-preview-button"
            aria-label={t("svgBlock.openViewer")}
            onClick={() => setZoomOpen(true)}
          >
            <img
              src={dataUri}
              alt={t("svgBlock.diagramTitle")}
              style={{ width: "100%", height: "auto", display: "block" }}
            />
          </button>
        </Tooltip>
      )}
      {zoomOpen && (
        <ZoomDialog
          ariaLabel={t("svgBlock.viewerLabel")}
          title={t("svgBlock.diagramTitle")}
          onClose={() => setZoomOpen(false)}
        >
          <img
            src={dataUri}
            alt={t("svgBlock.diagramTitle")}
            style={{ width: "100%", height: "auto", display: "block" }}
          />
        </ZoomDialog>
      )}
    </>
  );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">svg</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}
