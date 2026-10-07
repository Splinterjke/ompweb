"use client";
import { Tooltip } from "./ui/primitives";

import { memo, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { ZoomDialog } from "./ZoomDialog";
import { useTheme } from "@/hooks/useTheme";
import { useI18n } from "@/lib/i18n";
import { useCopyFeedback } from "@/hooks/useCopyFeedback";

interface MermaidBlockProps {
  code: string;
  isStreaming?: boolean;
  defaultPreview?: boolean;
}


type RenderState =
  | { key: string; status: "loading" }
  | { key: string; status: "error" }
  | { key: string; status: "ready"; svg: string };

export function MermaidBlock({ code, isStreaming, defaultPreview = false }: MermaidBlockProps) {
  const { isDark } = useTheme();
  const { t } = useI18n();
  const [showPreview, setShowPreview] = useState(defaultPreview);
  const [renderState, setRenderState] = useState<RenderState | null>(null);
  const [zoomOpen, setZoomOpen] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const currentKey = `${isDark ? "dark" : "light"}\n${code}`;
  const previewVisible = showPreview && !isStreaming;

  useEffect(() => {
    if (!previewVisible) return;

    let cancelled = false;
    setRenderState({ key: currentKey, status: "loading" });

    const render = async () => {
      const { default: mermaid } = await import("mermaid");
      mermaid.initialize({
        startOnLoad: false,
        securityLevel: "strict",
        suppressErrorRendering: true,
        theme: isDark ? "dark" : "default",
      });

      const parsed = await mermaid.parse(code, { suppressErrors: true });
      if (!parsed) throw new Error("Invalid Mermaid diagram");

      const id =
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? `mermaid-${crypto.randomUUID()}`
          : `mermaid-${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const result = await mermaid.render(id, code);
      if (!cancelled) {
        setRenderState({ key: currentKey, status: "ready", svg: result.svg });
      }
    };

    render().catch(() => {
      if (!cancelled) setRenderState({ key: currentKey, status: "error" });
    });

    return () => {
      cancelled = true;
    };
  }, [code, currentKey, isDark, previewVisible, retryKey]);

  const previewButton = (
        <Tooltip content={isStreaming ? t("mermaidBlock.previewAfterStreaming") : (previewVisible ? t("mermaidBlock.showSourceTitle") : t("mermaidBlock.previewTitle"))}>
      <button
        type="button"
        onClick={() => setShowPreview((v) => !v)}
        disabled={isStreaming}
        aria-label={isStreaming ? t("mermaidBlock.previewAfterStreaming") : (previewVisible ? t("mermaidBlock.showSourceTitle") : t("mermaidBlock.previewTitle"))}
        className={["markdown-code-action", previewVisible ? "is-active" : ""].filter(Boolean).join(" ")}
      >
        {previewVisible ? t("mermaidBlock.source") : t("mermaidBlock.preview")}
      </button>
    </Tooltip>
  );

  if (!previewVisible) {
    return <CodeBlock code={code} lang="mermaid" headerAction={previewButton} isStreaming={isStreaming} />;
  }

  const body = renderState?.key === currentKey && renderState.status === "error" ? (
      <div className="mermaid-block mermaid-block-error">
        <span>{t("mermaidBlock.invalidDiagram")}</span>
                <Tooltip content={t("mermaidBlock.retry")}>
          <button
            type="button"
            className="markdown-code-action"
            onClick={() => setRetryKey((key) => key + 1)}
            aria-label={t("mermaidBlock.retry")}
          >
            {t("mermaidBlock.retry")}
          </button>
        </Tooltip>
      </div>
    ) : renderState?.key !== currentKey || renderState.status !== "ready" ? (
      <div className="mermaid-block mermaid-block-loading" role="status">{t("mermaidBlock.rendering")}</div>
    ) : (
      <>
        {!zoomOpen && (
                    <Tooltip content={t("mermaidBlock.openViewer")}>
            <button
              type="button"
              className="mermaid-block mermaid-preview-button"
              aria-label={t("mermaidBlock.openViewer")}
              onClick={() => setZoomOpen(true)}
              dangerouslySetInnerHTML={{ __html: renderState.svg }}
            />
          </Tooltip>
        )}
        {zoomOpen && (
          <ZoomDialog
            ariaLabel={t("mermaidBlock.viewerLabel")}
            title={t("mermaidBlock.diagramTitle")}
            onClose={() => setZoomOpen(false)}
          >
            <div dangerouslySetInnerHTML={{ __html: renderState.svg }} />
          </ZoomDialog>
        )}
      </>
    );

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">mermaid</span>
        {previewButton}
      </div>
      {body}
    </div>
  );
}


interface CodeBlockProps {
  code: string;
  lang: string;
  headerAction?: ReactNode;
  isStreaming?: boolean;
}

/**
 * Syntax-highlighted code block with copy button.
 * Used as the "source" view for mermaid blocks and for all non-mermaid code fences.
 */
export const CodeBlock = memo(function CodeBlock({ code, lang, headerAction, isStreaming }: CodeBlockProps) {
  const { t } = useI18n();
  const { copied, copy } = useCopyFeedback();
  const [HighlightedCode, setHighlightedCode] = useState<ComponentType<{ code: string; lang: string }> | null>(null);

  useEffect(() => {
    if (isStreaming || HighlightedCode) return;
    let cancelled = false;
    void import("./SyntaxHighlightedCode").then(({ SyntaxHighlightedCode }) => {
      if (!cancelled) setHighlightedCode(() => SyntaxHighlightedCode);
    });
    return () => { cancelled = true; };
  }, [HighlightedCode, isStreaming]);

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span className="markdown-code-lang">{lang || "text"}</span>
        <div className="markdown-code-actions">
          {headerAction}
          <button
            onClick={() => copy(code)}
            className={copied ? "markdown-code-action is-copied" : "markdown-code-action"}
          >
            {copied ? t("codeBlock.copied") : t("codeBlock.copy")}
          </button>
        </div>
      </div>
      {isStreaming || !HighlightedCode ? (
        <pre style={{
          margin: 0,
          padding: "11px 13px",
          fontSize: "var(--chat-font-size, 14px)",
          lineHeight: 1.62,
          overflowX: "auto",
          backgroundColor: "color-mix(in srgb, var(--bg) 88%, var(--bg-panel))",
        }}>
          <code style={{ fontFamily: "var(--font-mono)" }}>{code}</code>
        </pre>
      ) : (
        <HighlightedCode code={code} lang={lang} />
      )}
    </div>
  );
});
