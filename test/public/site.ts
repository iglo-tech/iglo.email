// The site a test fixture's pages show when the fixture has no settings store of its own (B121).
// Production passes the settings getter; fixtures pass this, so every page is branded as it is in
// production, with the shell's defaults.
import type { PageSite } from "@/public/layout";

export const fixturePageSite = (): PageSite => ({
  siteName: "Mailing list",
  rootUrl: "http://fixture.test",
  logoUrl: "",
  faviconUrl: "",
  subscriptionPage: false,
  archive: false,
  siteUrl: "",
  accent: "",
  font: "system-sans",
  header: "auto",
});
