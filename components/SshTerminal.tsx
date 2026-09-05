"use client";

import { useEffect, useRef, useState } from "react";
import { Terminal, type ITheme } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { useI18n } from "@/hooks/useI18n";
import { useTheme, type ResolvedTheme } from "@/hooks/useTheme";
import {
  createSshInputQueue,
  decodeBase64ToBytes,
  encodeBase64Utf8,
  sendSshResize,
} from "@/lib/ssh-terminal-client";

const TERMINAL_THEMES: Record<ResolvedTheme, ITheme> = {
  light: {
    background: "#ffffff",
    foreground: "#1a1a1a",
    cursor: "#1a1a1a",
    cursorAccent: "#ffffff",
    selectionBackground: "#add6ff",
    black: "#000000",
    red: "#cd3131",
    green: "#00bc00",
    yellow: "#949800",
    blue: "#0451a5",
    magenta: "#bc05bc",
    cyan: "#0598bc",
    white: "#555555",
    brightBlack: "#666666",
    brightRed: "#cd3131",
    brightGreen: "#14ce14",
    brightYellow: "#b5ba00",
    brightBlue: "#0451a5",
    brightMagenta: "#bc05bc",
    brightCyan: "#0598bc",
    brightWhite: "#a5a5a5",
  },
  dark: {
    background: "#1a1a1a",
    foreground: "#d4d4d4",
    cursor: "#d4d4d4",
    cursorAccent: "#1a1a1a",
    selectionBackground: "#264f78",
    black: "#1a1a1a",
    red: "#f14c4c",
    green: "#23d18b",
    yellow: "#f5f543",
    blue: "#3b8eea",
    magenta: "#d670d6",
    cyan: "#29b8db",
    white: "#e5e5e5",
    brightBlack: "#666666",
    brightRed: "#f14c4c",
    brightGreen: "#23d18b",
    brightYellow: "#f5f543",
    brightBlue: "#3b8eea",
    brightMagenta: "#d670d6",
    brightCyan: "#29b8db",
    brightWhite: "#e5e5e5",
  },
};

const RESIZE_DEBOUNCE_MS = 150;
const MAX_DISCONNECTED_RETRIES = 5;

interface Props {
  sessionId: string;
}

export function SshTerminal({ sessionId }: Props) {
  const { t } = useI18n();
  const { theme } = useTheme();
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const [exited, setExited] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const terminal = new Terminal({
      // Concrete stack: canvas rendering cannot resolve CSS var() chains
      // like var(--font-mono), which silently falls back to a default font.
      fontFamily: "Menlo, Monaco, 'DejaVu Sans Mono', 'JetBrains Mono', Consolas, monospace",
      fontSize: 13,
      lineHeight: 1.15,
      cursorBlink: true,
      scrollback: 5000,
      theme: TERMINAL_THEMES[theme],
    });
    terminalRef.current = terminal;
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(container);

    let disposed = false;
    let exitedSession = false;
    const inputQueue = createSshInputQueue(sessionId);
    terminal.onData((data) => {
      if (!exitedSession) inputQueue.push(encodeBase64Utf8(data));
    });

    const safeFit = () => {
      try {
        fitAddon.fit();
      } catch {
        // Container may be momentarily unmeasurable (panel animating).
      }
    };
    safeFit();
    terminal.focus();

    // Keep the PTY size in sync with the panel; only notify the server when
    // the dimensions actually change.
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    let lastCols = terminal.cols;
    let lastRows = terminal.rows;
    const resizeObserver = new ResizeObserver(() => {
      safeFit();
      if (terminal.cols === lastCols && terminal.rows === lastRows) return;
      lastCols = terminal.cols;
      lastRows = terminal.rows;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!disposed && !exitedSession) void sendSshResize(sessionId, lastCols, lastRows);
      }, RESIZE_DEBOUNCE_MS);
    });
    resizeObserver.observe(container);

    const writeExitNotice = (code: number | null, signal: string | null) => {
      exitedSession = true;
      inputQueue.clear();
      setExited(true);
      terminal.write(
        `\r\n\x1b[2m${t("terminal.exited", { code: code ?? "-", signal: signal ?? "-" })}\x1b[0m\r\n`,
      );
    };

    // SSE downlink. Native EventSource reconnects on transient drops and the
    // server replays the ring buffer from Last-Event-ID.
    const es = new EventSource(`/api/ssh/${encodeURIComponent(sessionId)}/stream`);
    let everConnected = false;
    let errorCount = 0;
    es.addEventListener("connected", (event) => {
      everConnected = true;
      errorCount = 0;
      try {
        const data = JSON.parse((event as MessageEvent).data) as { exited?: boolean };
        if (data.exited) writeExitNotice(null, "exited");
      } catch { /* malformed frame is ignored */ }
    });
    const handleChunk = (event: MessageEvent) => {
      try {
        const data = JSON.parse(event.data) as { data?: string };
        if (data.data) terminal.write(decodeBase64ToBytes(data.data));
      } catch { /* malformed frame is ignored */ }
    };
    es.addEventListener("replay", handleChunk as EventListener);
    es.addEventListener("output", handleChunk as EventListener);
    es.addEventListener("exit", (event) => {
      es.close();
      try {
        const info = JSON.parse((event as MessageEvent).data) as { code?: number | null; signal?: string | null };
        writeExitNotice(info.code ?? null, info.signal ?? null);
      } catch {
        writeExitNotice(null, null);
      }
    });
    es.onerror = () => {
      if (!everConnected && ++errorCount >= MAX_DISCONNECTED_RETRIES) {
        es.close();
        exitedSession = true;
        inputQueue.clear();
        setExited(true);
        terminal.write(`\r\n\x1b[2m${t("terminal.disconnected")}\x1b[0m\r\n`);
      }
    };

    return () => {
      disposed = true;
      // Stop inbound writes before tearing the renderer down.
      es.close();
      resizeObserver.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      inputQueue.clear();
      terminal.dispose();
      terminalRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // Live theme swap without recreating the terminal.
  useEffect(() => {
    if (terminalRef.current) terminalRef.current.options.theme = TERMINAL_THEMES[theme];
  }, [theme]);

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column", background: "var(--bg)", position: "relative" }}>
      <div
        ref={containerRef}
        style={{ flex: 1, overflow: "hidden", padding: "6px 8px" }}
        aria-label={t("terminal.title")}
      />
      {exited && (
        <div
          style={{
            position: "absolute",
            top: 8,
            right: 12,
            fontSize: 11,
            color: "var(--text-dim)",
            background: "var(--bg-panel)",
            border: "1px solid var(--border)",
            borderRadius: 6,
            padding: "3px 8px",
            pointerEvents: "none",
          }}
        >
          {t("terminal.exitedBadge")}
        </div>
      )}
    </div>
  );
}
