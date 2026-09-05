"use client";

import { useEffect, useState } from "react";
import { useI18n } from "@/hooks/useI18n";
import {
  createSshSession,
  fetchSshDefaults,
  type SshSessionInfo,
} from "@/lib/ssh-terminal-client";

const STORAGE_KEY = "pi-ssh-connect";

interface Props {
  open: boolean;
  onConnected: (session: SshSessionInfo) => void;
  onClose: () => void;
}

const labelStyle: React.CSSProperties = {
  display: "block",
  fontSize: 12,
  color: "var(--text-muted)",
  marginBottom: 4,
};

const inputStyle: React.CSSProperties = {
  width: "100%",
  height: 30,
  padding: "0 8px",
  fontSize: 13,
  color: "var(--text)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  outline: "none",
};

export function SshConnectDialog({ open, onConnected, onClose }: Props) {
  const { t } = useI18n();
  const [host, setHost] = useState("127.0.0.1");
  const [port, setPort] = useState("22");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState("");
  const [connecting, setConnecting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Restore the last non-secret target and prefill the OS username.
  useEffect(() => {
    if (!open) return;
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as {
        host?: string;
        port?: string;
        username?: string;
      };
      if (saved.host) setHost(saved.host);
      if (saved.port) setPort(saved.port);
      if (saved.username) setUsername(saved.username);
    } catch {
      // Corrupt or unavailable storage: defaults are fine.
    }
    fetchSshDefaults()
      .then((defaults) => setUsername((prev) => prev || defaults.username || ""))
      .catch(() => { /* defaults are best-effort */ });
  }, [open]);

  useEffect(() => {
    if (open) return;
    setError(null);
    setPassword("");
    setPrivateKeyPath("");
    setConnecting(false);
  }, [open]);

  // Escape closes the dialog. The app-wide abort shortcut skips INPUT targets,
  // so this never conflicts with typing in the form.
  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const handleSubmit = async () => {
    if (connecting) return;
    const trimmedHost = host.trim();
    const trimmedUsername = username.trim();
    if (!trimmedHost || !trimmedUsername) {
      setError(t("terminal.connectFailed"));
      return;
    }
    setError(null);
    setConnecting(true);
    try {
      const session = await createSshSession({
        host: trimmedHost,
        port: Number.parseInt(port, 10) || 22,
        username: trimmedUsername,
        password: password.length > 0 ? password : undefined,
        privateKeyPath: privateKeyPath.trim().length > 0 ? privateKeyPath.trim() : undefined,
      });
      try {
        // Never persist the password or key path.
        localStorage.setItem(STORAGE_KEY, JSON.stringify({
          host: trimmedHost,
          port: String(Number.parseInt(port, 10) || 22),
          username: trimmedUsername,
        }));
      } catch {
        // Storage is best-effort.
      }
      onConnected(session);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setConnecting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={t("terminal.connect")}
      onClick={(event) => { if (event.target === event.currentTarget) onClose(); }}
      className="settings-dialog-backdrop"
    >
      <div
        className="settings-dialog-surface"
        style={{ width: 380, maxWidth: "calc(100vw - 32px)" }}
        onKeyDown={(event) => {
          if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) void handleSubmit();
        }}
      >
        <div className="settings-dialog-header">
          <strong className="settings-dialog-title">{t("terminal.connect")}</strong>
          <button
            type="button"
            onClick={onClose}
            title={t("i18n.close")}
            aria-label={t("i18n.close")}
            className="config-close-button settings-dialog-close"
          >
            ×
          </button>
        </div>
        <form
          onSubmit={(event) => { event.preventDefault(); void handleSubmit(); }}
          style={{ display: "flex", flexDirection: "column", gap: 12, padding: "14px 16px 16px" }}
        >
          <div style={{ display: "flex", gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label htmlFor="ssh-host" style={labelStyle}>{t("terminal.host")}</label>
              <input
                id="ssh-host"
                value={host}
                onChange={(event) => setHost(event.target.value)}
                placeholder="127.0.0.1"
                autoFocus
                style={inputStyle}
              />
            </div>
            <div style={{ width: 90 }}>
              <label htmlFor="ssh-port" style={labelStyle}>{t("terminal.port")}</label>
              <input
                id="ssh-port"
                value={port}
                onChange={(event) => setPort(event.target.value.replace(/[^0-9]/g, ""))}
                inputMode="numeric"
                style={inputStyle}
              />
            </div>
          </div>
          <div>
            <label htmlFor="ssh-username" style={labelStyle}>{t("terminal.username")}</label>
            <input
              id="ssh-username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="ssh-password" style={labelStyle}>{t("terminal.passwordOptional")}</label>
            <input
              id="ssh-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              style={inputStyle}
            />
          </div>
          <div>
            <label htmlFor="ssh-key-path" style={labelStyle}>{t("terminal.privateKeyPath")}</label>
            <input
              id="ssh-key-path"
              value={privateKeyPath}
              onChange={(event) => setPrivateKeyPath(event.target.value)}
              placeholder="~/.ssh/id_ed25519"
              style={inputStyle}
            />
          </div>
          {error && (
            <div style={{ fontSize: 12, color: "#ef4444", wordBreak: "break-word" }} role="alert">
              {error}
            </div>
          )}
          <button
            type="submit"
            disabled={connecting}
            style={{
              height: 32,
              marginTop: 2,
              fontSize: 13,
              fontWeight: 500,
              color: "#ffffff",
              background: "var(--accent)",
              border: "none",
              borderRadius: 6,
              cursor: connecting ? "default" : "pointer",
              opacity: connecting ? 0.6 : 1,
            }}
          >
            {connecting ? t("terminal.connecting") : t("terminal.connect")}
          </button>
        </form>
      </div>
    </div>
  );
}
