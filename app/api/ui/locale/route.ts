import { NextResponse } from "next/server";
import { getUiLocale, isUiLocale, setUiLocale, UI_LOCALES } from "@/lib/ui-locale";

export const dynamic = "force-dynamic";

// GET/PUT /api/ui/locale — the UI language chosen via "Switch language to".
// The client (LanguageSwitcher) syncs it here on load and on every change so
// server-side consumers that need the user's language (e.g. the $event_name
// chat-action variable) match the UI. Loopback-gated like the other /api/ui
// routes is not needed: the value is only used to pick a translation string,
// and the auth middleware gates /api/* when a password is set.

export function GET() {
  return NextResponse.json({ locale: getUiLocale() });
}

export async function PUT(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON request body", code: "invalid_json" }, { status: 400 });
  }
  const locale = (body as { locale?: unknown } | null)?.locale;
  if (!isUiLocale(locale)) {
    return NextResponse.json(
      { error: `locale must be one of: ${UI_LOCALES.join(", ")}`, code: "invalid_locale" },
      { status: 400 },
    );
  }
  setUiLocale(locale);
  return NextResponse.json({ locale });
}
