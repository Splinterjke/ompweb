// The /remote pairing landing page: opened on a phone from the pairing QR /
// link, it accepts the pairing token and reports the result. Routed by
// app/client.tsx on the URL pathname; the server serves the SPA shell for
// /remote without a session (proxy.ts keeps the pairing flow public).
import { useCallback, useEffect, useRef, useState } from "react";
import { CheckCircle2, LoaderCircle, Smartphone, XCircle } from "lucide-react";
import { useI18n } from "@/lib/i18n";
import { removeBootSkeleton } from "@/lib/boot-skeleton";

type PairState = "pairing" | "paired" | "failed" | "network-error";

export function RemotePairPage() {
  const { t } = useI18n();
  const [state, setState] = useState<PairState>("pairing");
  const [deviceName, setDeviceName] = useState<string | null>(null);
  const started = useRef(false);

  const attemptPair = useCallback(() => {
    setState("pairing");
    const token = new URLSearchParams(location.search).get("token");
    const isMobile = /iPhone|iPad|Android|Mobile/i.test(navigator.userAgent);
    void fetch("/api/pair/accept", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Requested-With": "omp-web-remote" },
      body: JSON.stringify({ token, mobile: isMobile }),
    })
      .then((res) => (res.ok ? res.json() as Promise<{ device: { name: string } }> : null))
      .then((body) => {
        if (!body) {
          setState("failed");
          return;
        }
        setDeviceName(body.device.name);
        setState("paired");
      })
      .catch(() => setState("network-error"));
  }, []);

  useEffect(() => {
    // /remote renders without AppShell, so the pre-paint boot skeleton the
    // server stamps into the shell would cover the pairing page forever.
    removeBootSkeleton();
    if (started.current) return;
    started.current = true;
    attemptPair();
  }, [attemptPair]);

  const base = location.origin;

  return (
    <main
      style={{
        minHeight: "100dvh",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        justifyContent: "center",
        gap: 16,
        padding: 24,
        background: "var(--bg)",
        color: "var(--text)",
        fontFamily: "var(--font-sans, system-ui, sans-serif)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        <Smartphone size={28} strokeWidth={1.8} style={{ color: "var(--accent)" }} aria-hidden="true" />
        <span style={{ fontSize: "calc(18px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}>{t("remote.pairingTitle")}</span>
      </div>

      {state === "pairing" && (
        <div style={{ display: "flex", alignItems: "center", gap: 8, color: "var(--text-muted)", fontSize: "calc(14px * var(--ui-font-scale-lg, 1))" }}>
          <LoaderCircle size={18} className="icon-spin" aria-hidden="true" />
          {t("remote.pairingInProgress")}
        </div>
      )}

      {state === "paired" && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <CheckCircle2 size={40} strokeWidth={1.6} style={{ color: "var(--status-ok, #2e9e5b)" }} aria-hidden="true" />
          <span style={{ fontSize: "calc(15px * var(--ui-font-scale-lg, 1))", fontWeight: 500 }}>{t("remote.pairedSuccess", { device: deviceName ?? "?" })}</span>
          <a
            href={base}
            style={{ padding: "10px 18px", borderRadius: "var(--radius-control)", background: "var(--accent)", color: "var(--bg)", textDecoration: "none", fontSize: "calc(14px * var(--ui-font-scale-lg, 1))", fontWeight: 600 }}
          >
            {t("remote.openApp")}
          </a>
        </div>
      )}

      {(state === "failed" || state === "network-error") && (
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 12 }}>
          <XCircle size={40} strokeWidth={1.6} style={{ color: "var(--status-error)" }} aria-hidden="true" />
          <span style={{ fontSize: "calc(15px * var(--ui-font-scale-lg, 1))", color: "var(--text-muted)", textAlign: "center", lineHeight: 1.5 }}>
            {state === "network-error" ? t("remote.networkError") : t("remote.pairingFailed")}
          </span>
          <button
            type="button"
            onClick={attemptPair}
            style={{ padding: "9px 16px", borderRadius: "var(--radius-control)", border: "1px solid var(--border)", background: "var(--bg-panel)", color: "var(--text)", cursor: "pointer", fontSize: "calc(13px * var(--ui-font-scale-lg, 1))" }}
          >
            {t("remote.retry")}
          </button>
        </div>
      )}
    </main>
  );
}
