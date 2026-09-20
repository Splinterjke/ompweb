"use client";

import { Sparkles, TerminalSquare, Compass, ShieldCheck, FileCode2, ArrowRight } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { isMacPlatform } from "@/lib/platform";

interface Props {
  onSelectPrompt: (prompt: string) => void;
  cwd?: string | null;
}

export function EmptyChatHero({ onSelectPrompt, cwd }: Props) {
  const { t } = useI18n();

  const promptCards = [
    {
      icon: Compass,
      title: t("emptyState.cardPlanTitle") || "Smart Planning",
      desc: t("emptyState.cardPlanDesc") || "Analyze the project structure, break down tasks, and produce an implementation plan",
      prompt: "/plan Analyze the current project's architecture and core modules, and plan the next steps",
      accent: "var(--accent)",
    },
    {
      icon: ShieldCheck,
      title: t("emptyState.cardReviewTitle") || "Code Review",
      desc: t("emptyState.cardReviewDesc") || "Review recent changes across correctness, type safety, and potential risks",
      prompt: "/review Review recent code changes for logic bugs and style issues",
      accent: "#38BDF8",
    },
    {
      icon: TerminalSquare,
      title: t("emptyState.cardTestTitle") || "Run Tests & Verify",
      desc: t("emptyState.cardTestDesc") || "Run the test suite, catch errors, and suggest fixes",
      prompt: "/test Run the test suite and verify feature integrity",
      accent: "#4ADE80",
    },
    {
      icon: FileCode2,
      title: t("emptyState.cardExploreTitle") || "Workspace Q&A",
      desc: t("emptyState.cardExploreDesc") || "Ask omp, and use @ to reference files or functions quickly",
      prompt: "Briefly describe the workspace's main features and directory structure",
      accent: "#FBBF24",
    },
  ];

  return (
    <div
      className="empty-chat-hero animate-fade-in"
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        padding: "32px 0 20px",
        textAlign: "center",
        maxWidth: 720,
        width: "100%",
        margin: "0 auto",
        userSelect: "none",
      }}
    >
      {/* 艺术字标题 Typography */}
      <div style={{ position: "relative", marginBottom: 12 }}>
        <div
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 6,
            padding: "3px 10px",
            borderRadius: 999,
            background: "color-mix(in srgb, var(--accent) 8%, var(--bg-panel))",
            border: "1px solid color-mix(in srgb, var(--accent) 22%, transparent)",
            color: "var(--accent)",
            fontSize: "calc(11px * var(--ui-font-scale, 1))",
            fontWeight: 600,
            letterSpacing: "0.06em",
            textTransform: "uppercase",
            marginBottom: 14,
            fontFamily: "var(--font-mono)",
          }}
        >
          <Sparkles size={12} strokeWidth={2.2} aria-hidden="true" />
          <span>OMP Coding Agent · Web Workspace</span>
        </div>

        <h1
          className="display-serif"
          style={{
            fontSize: "clamp(36px, 5.5vw, 54px)",
            lineHeight: 1.1,
            margin: "0 0 10px",
            fontWeight: 700,
            letterSpacing: "-0.03em",
            color: "var(--text)",
            textShadow: "0 2px 12px color-mix(in srgb, var(--accent) 15%, transparent)",
          }}
        >
          omp<span style={{ color: "var(--accent)", fontStyle: "italic", marginLeft: 2 }}>web</span>
        </h1>

        <p
          style={{
            fontSize: "clamp(13px, 2vw, 15px)",
            color: "var(--text-muted)",
            margin: "0 auto",
            maxWidth: 480,
            lineHeight: 1.6,
          }}
        >
          {t("emptyState.subtitle") || "Code hub · immersive multi-model collaboration and smart conversations"}
        </p>
      </div>

      {/* 快捷 Prompt 卡片 */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(280px, 1fr))",
          gap: 10,
          width: "100%",
          marginTop: 18,
          marginBottom: 16,
          textAlign: "left",
        }}
      >
        {promptCards.map((card, idx) => {
          const IconComponent = card.icon;
          return (
            <button
              key={idx}
              type="button"
              onClick={() => onSelectPrompt(card.prompt)}
              className="group ui-focus-ring"
              style={{
                display: "flex",
                flexDirection: "column",
                gap: 6,
                padding: "12px 14px",
                borderRadius: "var(--radius-card)",
                background: "var(--bg-panel)",
                border: "1px solid var(--border)",
                cursor: "pointer",
                transition: "all var(--dur-fast) var(--ease-out-warm)",
                boxShadow: "var(--shadow-card)",
                textAlign: "left",
              }}
              onMouseEnter={(e) => {
                e.currentTarget.style.transform = "translateY(-1px)";
                e.currentTarget.style.borderColor = "color-mix(in srgb, var(--accent) 50%, var(--border))";
                e.currentTarget.style.boxShadow = "var(--shadow-pop)";
              }}
              onMouseLeave={(e) => {
                e.currentTarget.style.transform = "none";
                e.currentTarget.style.borderColor = "var(--border)";
                e.currentTarget.style.boxShadow = "var(--shadow-card)";
              }}
            >
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", width: "100%" }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <span
                    style={{
                      display: "inline-flex",
                      alignItems: "center",
                      justifyContent: "center",
                      width: 26,
                      height: 26,
                      borderRadius: 6,
                      background: "var(--bg-hover)",
                      color: card.accent,
                    }}
                  >
                    <IconComponent size={15} strokeWidth={2} />
                  </span>
                  <span style={{ fontSize: "calc(13px * var(--ui-font-scale, 1))", fontWeight: 600, color: "var(--text)" }}>{card.title}</span>
                </div>
                <ArrowRight
                  size={13}
                  strokeWidth={2}
                  style={{
                    color: "var(--text-dim)",
                    opacity: 0.6,
                    transition: "transform var(--dur-fast)",
                  }}
                />
              </div>
              <p style={{ margin: 0, fontSize: "calc(12px * var(--ui-font-scale, 1))", color: "var(--text-muted)", lineHeight: 1.45 }}>
                {card.desc}
              </p>
            </button>
          );
        })}
      </div>

      {/* 底部快捷键提示 */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "center",
          gap: 12,
          fontSize: "calc(11px * var(--ui-font-scale, 1))",
          color: "var(--text-dim)",
          fontFamily: "var(--font-mono)",
        }}
      >
        <span>
          Type <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "var(--bg-hover)", border: "1px solid var(--border)" }}>/</kbd> for commands
        </span>
        <span>·</span>
        <span>
          Use <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "var(--bg-hover)", border: "1px solid var(--border)" }}>@</kbd> to reference files
        </span>
        <span>·</span>
        <span>
          <kbd style={{ padding: "1px 5px", borderRadius: 4, background: "var(--bg-hover)", border: "1px solid var(--border)" }}>{isMacPlatform() ? "⌘K" : "Ctrl K"}</kbd> command palette
        </span>
      </div>
    </div>
  );
}
