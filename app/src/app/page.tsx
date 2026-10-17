"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Demo window into the backend (design is not evaluated). Polls the API every 2 s and shows the
 * state machine at work: scheduled -> publishing -> published/failed, and WHY a post waits or fails.
 */

interface Post {
  id: string;
  ambassador_id: string;
  ambassador_name: string;
  content: string;
  status: string;
  scheduled_at: string | null;
  due_at: string | null;
  timezone: string;
  attempts: number;
  external_id: string | null;
  last_error: { code: string; detail: string | null } | null;
  ambassador_throttle: { reason: string | null; until: string } | null;
  created_at: string;
}

interface Ambassador {
  id: string;
  display_name: string;
  due_now: number;
  in_flight: number;
  throttled_until: string | null;
  throttle_reason: string | null;
  last_outcome: string | null;
  last_retry_after_sec: number | null;
}

interface Transition {
  at: string;
  post: string;
  from: string;
  to: string;
}

const STATUS_COLORS: Record<string, string> = {
  draft: "#888",
  scheduled: "#1f6feb",
  publishing: "#d29922",
  published: "#2da44e",
  failed: "#cf222e",
  cancelled: "#999",
};

const TIMEZONES = ["Europe/Madrid", "UTC", "Europe/London", "America/New_York", "America/Sao_Paulo"];

function readToken(): string {
  try {
    return sessionStorage.getItem("ploot_token") ?? "";
  } catch {
    return "";
  }
}

function saveToken(t: string): void {
  try {
    sessionStorage.setItem("ploot_token", t);
  } catch {
    // private mode: keep it in memory only
  }
}

function fmt(iso: string | null, timeZone = "Europe/Madrid"): string {
  if (!iso) return "—";
  if (iso === "infinity") return "indefinido";
  const d = new Date(iso.includes("T") ? iso : iso.replace(" ", "T"));
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("es-ES", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(d);
}

/** The "why" column: typed error, provider throttling or backoff, in plain words. */
function why(p: Post): string {
  if (p.status === "failed" && p.last_error) return `❌ ${p.last_error.code}: ${p.last_error.detail ?? ""}`;
  if (p.status === "published") return `✅ external_id ${p.external_id}`;
  if (p.status === "scheduled" || p.status === "publishing") {
    const parts: string[] = [];
    if (p.ambassador_throttle) {
      parts.push(`⏸ Embajador en espera (${p.ambassador_throttle.reason}) hasta ${fmt(p.ambassador_throttle.until)}`);
    }
    if (p.last_error) parts.push(`↻ ${p.last_error.code}: ${p.last_error.detail ?? ""}`);
    if (p.status === "scheduled" && p.due_at && new Date(p.due_at) > new Date() && p.last_error) {
      parts.push(`siguiente intento ${fmt(p.due_at)}`);
    }
    return parts.join(" · ");
  }
  return "";
}

export default function Home() {
  const [token, setToken] = useState("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [ambassadors, setAmbassadors] = useState<Ambassador[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState({
    content: "",
    ambassador_id: "",
    local: "",
    timezone: "Europe/Madrid",
    status: "scheduled",
  });
  const lastStatus = useRef(new Map<string, string>());

  useEffect(() => setToken(readToken()), []);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(`${res.status} ${body?.error?.code ?? ""}: ${body?.error?.message ?? ""}`);
      return body;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const [p, a] = await Promise.all([api("/api/v1/posts?limit=50"), api("/api/v1/ambassadors")]);
      const seen: Transition[] = [];
      for (const post of p.data as Post[]) {
        const prev = lastStatus.current.get(post.id);
        if (prev && prev !== post.status) {
          seen.push({ at: new Date().toLocaleTimeString("es-ES"), post: post.content.slice(0, 40), from: prev, to: post.status });
        }
        lastStatus.current.set(post.id, post.status);
      }
      if (seen.length) setTransitions((t) => [...seen, ...t].slice(0, 30));
      setPosts(p.data);
      setAmbassadors(a.data);
      setError(null);
    } catch (e) {
      setError(String(e));
    }
  }, [api, token]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  async function demoLogin(tenant: "acme" | "globex") {
    const res = await fetch("/api/demo/login", { method: "POST", body: JSON.stringify({ tenant }) });
    const body = await res.json();
    if (!res.ok) return setError("Login de demo deshabilitado: pega un JWT.");
    lastStatus.current.clear();
    setTransitions([]);
    saveToken(body.token);
    setToken(body.token);
  }

  async function create(e: React.FormEvent) {
    e.preventDefault();
    try {
      const body: Record<string, unknown> = { content: form.content, status: form.status, timezone: form.timezone };
      if (form.ambassador_id) body.ambassador_id = form.ambassador_id;
      if (form.local) body.scheduled_local = form.local;
      await api("/api/v1/posts", { method: "POST", body: JSON.stringify(body) });
      setForm((f) => ({ ...f, content: "" }));
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  async function action(post: Post, kind: "publish" | "cancel") {
    try {
      if (kind === "publish") {
        // A fresh key per click; a network retry of the same click would reuse it.
        await api(`/api/v1/posts/${post.id}/publish`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
      } else {
        await api(`/api/v1/posts/${post.id}`, { method: "DELETE" });
      }
      await refresh();
    } catch (err) {
      setError(String(err));
    }
  }

  const cell = { padding: "4px 8px", borderBottom: "1px solid #eee", verticalAlign: "top" } as const;

  return (
    <main>
      <h1 style={{ marginBottom: 4 }}>Ploot · scheduler</h1>
      <p style={{ marginTop: 0, color: "#666" }}>Ventana al backend: los workers publican contra el proveedor simulado.</p>

      <section style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button onClick={() => void demoLogin("acme")}>Entrar como acme (Ana)</button>
        <button onClick={() => void demoLogin("globex")}>Entrar como globex (Diego)</button>
        <input
          placeholder="…o pega un JWT"
          value={token}
          onChange={(e) => {
            saveToken(e.target.value);
            setToken(e.target.value);
          }}
          style={{ flex: 1, minWidth: 200 }}
        />
      </section>
      {error && <p style={{ color: "#cf222e" }}>{error}</p>}

      {token && (
        <>
          <h2>Embajadores</h2>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                {["Embajador", "Vencidos", "En vuelo", "En espera hasta", "Motivo", "Último resultado"].map((h) => (
                  <th key={h} style={{ ...cell, textAlign: "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {ambassadors.map((a) => (
                <tr key={a.id}>
                  <td style={cell}>{a.display_name}</td>
                  <td style={cell}>{a.due_now}</td>
                  <td style={cell}>{a.in_flight}</td>
                  <td style={cell}>{fmt(a.throttled_until)}</td>
                  <td style={cell}>{a.throttle_reason ?? "—"}</td>
                  <td style={cell}>
                    {a.last_outcome ?? "—"}
                    {a.last_retry_after_sec ? ` (Retry-After ${a.last_retry_after_sec}s)` : ""}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Nuevo post</h2>
          <form onSubmit={(e) => void create(e)} style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <input
              required
              placeholder="Contenido"
              value={form.content}
              onChange={(e) => setForm({ ...form, content: e.target.value })}
              style={{ flex: 2, minWidth: 200 }}
            />
            <select value={form.ambassador_id} onChange={(e) => setForm({ ...form, ambassador_id: e.target.value })}>
              <option value="">(yo)</option>
              {ambassadors.map((a) => (
                <option key={a.id} value={a.id}>{a.display_name}</option>
              ))}
            </select>
            <input type="datetime-local" value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value })} />
            <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
              {TIMEZONES.map((tz) => (
                <option key={tz}>{tz}</option>
              ))}
            </select>
            <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
              <option value="scheduled">programar</option>
              <option value="draft">borrador</option>
            </select>
            <button type="submit">Crear</button>
          </form>

          <h2>Posts</h2>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 14 }}>
            <thead>
              <tr>
                {["Embajador", "Contenido", "Estado", "Programado", "Intentos", "Por qué", ""].map((h) => (
                  <th key={h} style={{ ...cell, textAlign: "left" }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {posts.map((p) => (
                <tr key={p.id}>
                  <td style={cell}>{p.ambassador_name}</td>
                  <td style={{ ...cell, maxWidth: 260 }}>{p.content}</td>
                  <td style={cell}>
                    <span style={{ color: "white", background: STATUS_COLORS[p.status], padding: "1px 6px", borderRadius: 4 }}>
                      {p.status}
                    </span>
                  </td>
                  <td style={cell}>
                    {fmt(p.scheduled_at, p.timezone)}
                    <div style={{ color: "#888", fontSize: 12 }}>{p.timezone}</div>
                  </td>
                  <td style={cell}>{p.attempts}</td>
                  <td style={{ ...cell, maxWidth: 320, fontSize: 13 }}>{why(p)}</td>
                  <td style={{ ...cell, whiteSpace: "nowrap" }}>
                    {["draft", "scheduled", "failed"].includes(p.status) && (
                      <button onClick={() => void action(p, "publish")}>Publicar ahora</button>
                    )}{" "}
                    {["draft", "scheduled", "failed"].includes(p.status) && (
                      <button onClick={() => void action(p, "cancel")}>Cancelar</button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>

          <h2>Transiciones observadas</h2>
          <ul style={{ fontSize: 13, fontFamily: "ui-monospace, monospace" }}>
            {transitions.length === 0 && <li style={{ color: "#888" }}>Esperando cambios de estado…</li>}
            {transitions.map((t, i) => (
              <li key={i}>
                {t.at} · {t.post} · {t.from} → <b>{t.to}</b>
              </li>
            ))}
          </ul>
        </>
      )}
    </main>
  );
}
