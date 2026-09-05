"use client";

import { useI18n } from "@/hooks/useI18n";
import { encodeFilePathForApi } from "@/lib/file-paths";

/**
 * Fork-local addition: iframe for the streaming HTML preview route
 * (/api/file-preview). Used by FileViewer for HTML files that exceed the
 * 256KB text-read cap, where the whole content cannot be shipped through
 * type=read and embedded via srcDoc. Kept in its own component file so
 * upstream FileViewer changes stay mergeable — the viewer only renders this
 * component in one extra branch.
 */

export function getHtmlPreviewUrl(
  filePath: string,
  sourceSessionId?: string | null,
  bust?: number,
): string {
  const encoded = encodeFilePathForApi(filePath);
  const searchParams = new URLSearchParams();
  if (sourceSessionId) searchParams.set("sessionId", sourceSessionId);
  if (bust) searchParams.set("v", String(bust));
  const query = searchParams.toString();
  return `/api/file-preview/${encoded}${query ? `?${query}` : ""}`;
}

export function HtmlPreviewFrame({
  filePath,
  sourceSessionId,
  bust,
}: {
  filePath: string;
  sourceSessionId?: string | null;
  bust?: number;
}) {
  const { t } = useI18n();
  return (
    <iframe
      // Opaque-origin sandbox: scripts run, but the framed document cannot
      // read cookies or reach same-origin APIs (its requests are cross-site).
      sandbox="allow-scripts"
      src={getHtmlPreviewUrl(filePath, sourceSessionId, bust)}
      style={{ width: "100%", height: "100%", border: "none", background: "var(--bg)" }}
      title={t("i18n.htmlPreview")}
    />
  );
}
