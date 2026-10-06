import { headers } from "next/headers";
import { getInstallName } from "@/lib/install-name";
import { HomeClient } from "./home-client";

export default async function Home() {
  const appName = getInstallName(await headers());
  return <HomeClient appName={appName} />;
}
