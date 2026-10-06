"use client";

import dynamic from "next/dynamic";

const AppShell = dynamic(() => import("@/components/AppShell").then((m) => m.AppShell), {
  ssr: false,
});

/** Client shell for the server page: the install name is resolved from the
 * request Host header at render time and handed down to the window-title
 * sync in AppShell. */
export function HomeClient({ appName }: { appName: string }) {
  return <AppShell appName={appName} />;
}
