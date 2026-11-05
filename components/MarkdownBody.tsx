"use client";

import { Children, cloneElement, isValidElement, useContext, useMemo, type ComponentProps, type MouseEvent, type ReactElement, type ReactNode } from "react";
import ReactMarkdown, { type Components, type UrlTransform } from "react-markdown";
import { AgentLinkContext, agentAwareUrlTransform, agentLinkIds } from "../lib/agent-links";
import { remarkInlineCodeFileLinks, resolveLocalFileHref } from "@/lib/file-links";
import { getFileApiUrl } from "@/lib/file-paths";
import { WorkspaceFileContext } from "@/lib/workspace-file-context";
import { GithubRepoContext, remarkGithubRefs } from "../lib/github-refs";
import { normalizeDisplayMath, useMarkdownPlugins, type MarkdownPlugins } from "../lib/markdown";
import { markdownCodeRenderer } from "./MarkdownCode";
import { ClickableImage } from "./ImageLightbox";
import { TableChart } from "./TableChart";

// The default sanitizer reads `C:` as a scheme; a drive path (`\` arrives as `%5C`) is a local file the `a` renderer opens.
const urlTransform: UrlTransform = (url, key, node) => (/^[A-Za-z]:(?:\/|%5C)/i.test(url) ? url : agentAwareUrlTransform(url, key, node));

interface MarkdownBodyProps {
  children: string;
  className?: string;
  isStreaming?: boolean;
  cwd?: string;
  onOpenFile?: (filePath: string) => void;
  /** Replace images with their alt text (print/export renderers). */
  suppressImages?: boolean;
  autoCharts?: boolean;
}

export function MarkdownBody({ children, className, isStreaming, cwd, onOpenFile, suppressImages = false, autoCharts = false }: MarkdownBodyProps) {
  // Skip normalizeDisplayMath while streaming: it scans the entire document
  // on every token batch but math content almost never arrives mid-stream.
  // The normalization runs once on the final committed message instead.
  const normalizedMarkdown = useMemo(
    () => (isStreaming ? children : normalizeDisplayMath(children)),
    [children, isStreaming],
  );
  const fileSource = useContext(WorkspaceFileContext);
  const { remarkPlugins: baseRemarkPlugins, rehypePlugins } = useMarkdownPlugins(isStreaming ? "" : normalizedMarkdown, isStreaming);
  const githubRepo = useContext(GithubRepoContext);
  // Inline-code paths link only where a click can open them. The plugin runs
  // before the shared remarkPathLinks so its `<code>`-keeping link wins for
  // the path shapes it recognizes (that legacy plugin clips `:line` suffixes
  // and drops the code styling).
  const remarkPlugins = useMemo<MarkdownPlugins["remarkPlugins"]>(
    () => {
      // GitHub refs run first: `agent://Foo#12` must not become an issue link.
      const plugins: MarkdownPlugins["remarkPlugins"] = [...baseRemarkPlugins, [remarkGithubRefs, { repo: githubRepo }]];
      return onOpenFile ? [[remarkInlineCodeFileLinks, { cwd }] as MarkdownPlugins["remarkPlugins"][number], ...plugins] : plugins;
    },
    [baseRemarkPlugins, githubRepo, onOpenFile, cwd],
  );
  const openAgentLink = useContext(AgentLinkContext);

  // Rebuilt only when its captured props change, not on every render.
  const components = useMemo<Components>(() => {
    const imgComponent = ({ src, alt, ...imgProps }: ComponentProps<"img"> & { node?: unknown }) => {
      if (suppressImages) return alt ?? null;
      // `node` is react-markdown metadata, not a DOM attribute.
      delete (imgProps as { node?: unknown }).node;
      // react-markdown URL-encodes drive-letter srcs; resolveLocalFileHref
      // decodes them back before resolving.
      const filePath = typeof src === "string" ? resolveLocalFileHref(src, cwd) : null;
      const imageSrc = filePath
        ? getFileApiUrl(filePath, "read", fileSource?.hostId ?? "local", fileSource?.sessionId)
        : src;
      // Dynamic local paths are served directly by the file API.
      return <ClickableImage src={imageSrc} alt={alt ?? ""} loading="lazy" {...imgProps} />;
    };

    /**
     * Split link children into linked text and previewable images. Images may
     * sit directly or wrapped in formatting (`[**![img](x)**](url)`); a
     * <button> can never nest inside an <a>, so image content is extracted
     * while text (with its formatting) stays linked.
     */
    const isElementWithChildren = (value: unknown): value is ReactElement<{ children?: ReactNode }> => isValidElement(value);
    const partitionLinkContent = (node: ReactNode): { textParts: ReactNode[]; imageParts: ReactNode[] } => {
      const textParts: ReactNode[] = [];
      const imageParts: ReactNode[] = [];
      for (const child of Children.toArray(node)) {
        if (!isElementWithChildren(child)) {
          textParts.push(child);
          continue;
        }
        if (child.type === imgComponent) {
          imageParts.push(child);
          continue;
        }
        const sub = partitionLinkContent(child.props.children);
        if (sub.imageParts.length === 0) {
          textParts.push(child);
        } else if (sub.textParts.length === 0) {
          // Formatting wrapper containing only images moves to the previews.
          imageParts.push(child);
        } else {
          // Mixed wrapper: keep the wrapper with its text, extract the images.
          textParts.push(cloneElement(child, undefined, sub.textParts));
          imageParts.push(...sub.imageParts);
        }
      }
      return { textParts, imageParts };
    };
    /** True when any text part carries non-whitespace content. */
    const hasMeaningfulText = (parts: ReactNode[]): boolean =>
      parts.some((part) => {
        if (typeof part === "string") return part.trim().length > 0;
        if (typeof part === "number") return true;
        if (isElementWithChildren(part)) return hasMeaningfulText(Children.toArray(part.props.children));
        return false;
      });

    return {
    code: markdownCodeRenderer({ isStreaming, inlineClassName: "markdown-inline-code" }),
    pre({ children }) {
      return <>{children}</>;
    },
    a({ href, children, ...props }) {
      // `node` is react-markdown metadata, not a DOM attribute.
      delete props.node;
      // react-markdown URL-encodes drive-letter hrefs (C:%5CUsers...);
      // resolveLocalFileHref decodes them back before resolving.
      const { textParts, imageParts } = partitionLinkContent(children);
      // A <button> cannot nest inside an <a>. Pure image links (direct or
      // wrapped in formatting, possibly with surrounding whitespace) render
      // only the previews — the lightbox supersedes the link. Mixed links
      // keep their text linked and render image previews beside the anchor.
      if (imageParts.length > 0 && !hasMeaningfulText(textParts)) {
        return <>{children}</>;
      }
      const agentIds = agentLinkIds(href);
      if (agentIds.length > 0) {
        // Outside a chat view there is nothing to open: render the handle as text.
        if (!openAgentLink) return <>{textParts}{imageParts}</>;
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          if (event.defaultPrevented || event.button !== 0) return;
          event.preventDefault();
          openAgentLink(agentIds);
        };
        // Middle-click never fires `click`; stop it opening the unnavigable href.
        const anchor = <a href={href} {...props} onClick={handleClick} onAuxClick={(event) => event.preventDefault()}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }
      const filePath = resolveLocalFileHref(href, cwd);
      if (filePath) {
        // Without a file panel (a remote host's session, a dialog) a path link has nowhere to go: show its text.
        if (!onOpenFile) return <>{textParts}{imageParts}</>;
        const openFile = onOpenFile;
        const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
          // No modifier escape hatch: the href is a filesystem path, which the browser cannot open in a new tab.
          if (event.defaultPrevented || event.button !== 0) return;
          const target = event.currentTarget.getAttribute("target");
          if (target && target !== "_self") return;
          event.preventDefault();
          openFile(filePath);
        };
        const anchor = <a href={href} {...props} onClick={handleClick} onAuxClick={(event) => event.preventDefault()}>{textParts}</a>;
        return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
      }

      const anchor = (
        <a {...props} href={href} target="_blank" rel="noopener noreferrer">
          {textParts}
        </a>
      );
      return imageParts.length > 0 ? <>{anchor}{imageParts}</> : anchor;
    },
    img: imgComponent,
    table({ children, node }) {
      return (
        <TableChart node={node} enabled={autoCharts && !isStreaming}>
        <div className="markdown-table-wrap">
          <table>{children}</table>
        </div>
        </TableChart>
      );
    },
    };
  }, [isStreaming, cwd, onOpenFile, suppressImages, openAgentLink, autoCharts, fileSource]);

  return (
    <div className={["markdown-body", className].filter(Boolean).join(" ")}>
      <ReactMarkdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={urlTransform}
      >
        {normalizedMarkdown}
      </ReactMarkdown>
    </div>
  );
}
