"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/*
 * Demo window into the backend (design is not evaluated). Polls the API every 2 s and shows the
 * state machine at work (scheduled -> publishing -> published/failed) and WHY a post waits or fails.
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
  who: string;
  from: string;
  to: string;
}

type Tenant = "acme" | "globex";

const DEMO_USERS: { tenant: Tenant; name: string; blurb: string }[] = [
  {
    tenant: "acme",
    name: "Ana · tenant acme",
    blurb: "Embajadores Ana, Bruno y Carla. Bruno tiene una ráfaga de posts (verás el pacing) y Carla un token caducado que el worker refresca solo.",
  },
  {
    tenant: "globex",
    name: "Diego · tenant globex",
    blurb: "Embajadores Diego, Elena, Fede y Gina. Fede tiene el token revocado: su post falla sin reintentos y su cola queda en pausa.",
  },
];

const STATUS: Record<string, { label: string; color: string; bg: string }> = {
  draft: { label: "Borrador", color: "#57606a", bg: "#eaeef2" },
  scheduled: { label: "Programado", color: "#0969da", bg: "#ddf4ff" },
  publishing: { label: "Publicando…", color: "#9a6700", bg: "#fff8c5" },
  published: { label: "Publicado", color: "#1a7f37", bg: "#dafbe1" },
  failed: { label: "Fallido", color: "#cf222e", bg: "#ffebe9" },
  cancelled: { label: "Cancelado", color: "#57606a", bg: "#eaeef2" },
};

const ERRORS: Record<string, string> = {
  token_revoked: "El token del Embajador está revocado: tiene que volver a conectar su cuenta. No se reintenta.",
  provider_unavailable: "La red social falló (5xx) en todos los intentos.",
  outcome_unknown: "No sabemos si llegó a publicarse (caída o timeout). No se reintenta para no duplicar el post.",
  invalid_content: "La red social rechazó el contenido.",
  network_error: "No se pudo contactar con la red social; se reintentará.",
  token_refresh_unavailable: "No se pudo refrescar el token; se reintentará.",
  rate_limited: "La red social pidió esperar (429 · Retry-After).",
  account_restricted: "La red social restringió la cuenta temporalmente.",
};

const THROTTLE: Record<string, string> = {
  pacing: "Espaciado entre posts para no hacer ráfagas",
  rate_limited: "Límite de la red social (429): esperando Retry-After",
  account_restricted: "Cuenta restringida por la red social",
  token_revoked: "En pausa: token revocado",
};

const TIMEZONES = ["Europe/Madrid", "UTC", "Europe/London", "America/New_York", "America/Sao_Paulo"];

function storage(key: string, value?: string): string {
  try {
    if (value === undefined) return sessionStorage.getItem(key) ?? "";
    if (value) sessionStorage.setItem(key, value);
    else sessionStorage.removeItem(key);
  } catch {
    // private mode: in-memory only
  }
  return value ?? "";
}

function decodeToken(token: string): { tenant_id?: string; profile_id?: string; exp?: number } {
  try {
    return JSON.parse(atob(token.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/")));
  } catch {
    return {};
  }
}

function parseInstant(iso: string | null): Date | null {
  if (!iso || iso === "infinity") return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d;
}

function fmt(iso: string | null, timeZone = "Europe/Madrid"): string {
  const d = parseInstant(iso);
  if (!d) return iso === "infinity" ? "indefinido" : "—";
  return new Intl.DateTimeFormat("es-ES", { timeZone, dateStyle: "short", timeStyle: "medium" }).format(d);
}

function relative(iso: string | null, now: number): string {
  if (iso === "infinity") return "hasta reconectar";
  const d = parseInstant(iso);
  if (!d) return "";
  const s = Math.round((d.getTime() - now) / 1000);
  const abs = Math.abs(s);
  const txt = abs < 60 ? `${abs} s` : abs < 3600 ? `${Math.round(abs / 60)} min` : `${Math.round(abs / 3600)} h`;
  return s >= 0 ? `en ${txt}` : `hace ${txt}`;
}

/** Local wall-clock "YYYY-MM-DDTHH:mm" in a zone, for the datetime-local input. */
function localInput(date: Date, timeZone: string): string {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    })
      .formatToParts(date)
      .map((x) => [x.type, x.value]),
  );
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

function why(p: Post, now: number): { text: string; tone: "ok" | "bad" | "wait" | "" } {
  if (p.status === "failed" && p.last_error) {
    return { text: `${ERRORS[p.last_error.code] ?? p.last_error.code} (${p.last_error.code})`, tone: "bad" };
  }
  if (p.status === "published") return { text: `Publicado en la red social · id ${p.external_id}`, tone: "ok" };
  if (p.status === "publishing") return { text: "El worker lo está enviando ahora mismo.", tone: "wait" };
  if (p.status === "scheduled") {
    const parts: string[] = [];
    if (p.ambassador_throttle) {
      const reason = THROTTLE[p.ambassador_throttle.reason ?? ""] ?? p.ambassador_throttle.reason;
      parts.push(`${reason} (${relative(p.ambassador_throttle.until, now)})`);
    }
    if (p.last_error) parts.push(ERRORS[p.last_error.code] ?? p.last_error.code);
    const due = parseInstant(p.due_at);
    if (due && due.getTime() > now) parts.push(`Se publicará ${relative(p.due_at, now)}`);
    else if (!parts.length) parts.push("Le toca ya: el worker lo cogerá en segundos.");
    return { text: parts.join(" · "), tone: "wait" };
  }
  return { text: "", tone: "" };
}

export default function Home() {
  const [token, setToken] = useState("");
  const [tenant, setTenant] = useState<Tenant | "">("");
  const [posts, setPosts] = useState<Post[]>([]);
  const [ambassadors, setAmbassadors] = useState<Ambassador[]>([]);
  const [transitions, setTransitions] = useState<Transition[]>([]);
  const [flashIds, setFlashIds] = useState<Set<string>>(new Set());
  const [toast, setToast] = useState<{ text: string; tone: "ok" | "bad" } | null>(null);
  const [filter, setFilter] = useState("");
  const [now, setNow] = useState(() => Date.now());
  const [origin, setOrigin] = useState("");
  const [form, setForm] = useState({ content: "", ambassador_id: "", local: "", timezone: "Europe/Madrid", status: "scheduled" });
  const lastStatus = useRef(new Map<string, string>());

  const notify = useCallback((text: string, tone: "ok" | "bad" = "ok") => {
    setToast({ text, tone });
    setTimeout(() => setToast(null), 4500);
  }, []);

  const login = useCallback(
    async (t: Tenant) => {
      const res = await fetch("/api/demo/login", { method: "POST", body: JSON.stringify({ tenant: t }) });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) return notify("El login de demo está deshabilitado: pega un JWT abajo.", "bad");
      lastStatus.current.clear();
      setTransitions([]);
      setToken(storage("ploot_token", body.token));
      setTenant(storage("ploot_tenant", t) as Tenant);
      notify(`Has entrado como ${t === "acme" ? "Ana (acme)" : "Diego (globex)"}`);
    },
    [notify],
  );

  // Restore session, or auto-login with ?as=acme|globex (handy link for reviewers).
  useEffect(() => {
    setOrigin(window.location.origin);
    setForm((f) => ({ ...f, local: localInput(new Date(Date.now() + 5 * 60_000), f.timezone) }));
    const as = new URLSearchParams(window.location.search).get("as");
    if (as === "acme" || as === "globex") void login(as);
    else {
      setToken(storage("ploot_token"));
      setTenant(storage("ploot_tenant") as Tenant | "");
    }
  }, [login]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  const api = useCallback(
    async (path: string, init: RequestInit = {}) => {
      const res = await fetch(path, {
        ...init,
        headers: { "content-type": "application/json", authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body?.error?.message ? `${body.error.message} (${body.error.code})` : `HTTP ${res.status}`);
      return body;
    },
    [token],
  );

  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const qs = filter ? `&status=${filter}` : "";
      const [p, a] = await Promise.all([api(`/api/v1/posts?limit=50${qs}`), api("/api/v1/ambassadors")]);
      const seen: Transition[] = [];
      const changed = new Set<string>();
      for (const post of p.data as Post[]) {
        const prev = lastStatus.current.get(post.id);
        if (prev && prev !== post.status) {
          seen.push({
            at: new Date().toLocaleTimeString("es-ES"),
            post: post.content.slice(0, 50),
            who: post.ambassador_name,
            from: prev,
            to: post.status,
          });
          changed.add(post.id);
        }
        lastStatus.current.set(post.id, post.status);
      }
      if (seen.length) setTransitions((t) => [...seen, ...t].slice(0, 40));
      if (changed.size) {
        setFlashIds(changed);
        setTimeout(() => setFlashIds(new Set()), 1700);
      }
      setPosts(p.data);
      setAmbassadors(a.data);
    } catch (e) {
      if (String(e).includes("invalid_token") || String(e).includes("unauthenticated")) {
        setToken(storage("ploot_token", ""));
        notify("La sesión ha caducado: vuelve a entrar.", "bad");
      }
    }
  }, [api, token, filter, notify]);

  useEffect(() => {
    void refresh();
    const t = setInterval(() => void refresh(), 2000);
    return () => clearInterval(t);
  }, [refresh]);

  async function createPost(body: Record<string, unknown>, okText: string) {
    try {
      await api("/api/v1/posts", { method: "POST", body: JSON.stringify(body) });
      notify(okText);
      await refresh();
    } catch (err) {
      notify(String(err).replace(/^Error: /, ""), "bad");
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    const body: Record<string, unknown> = { content: form.content, status: form.status, timezone: form.timezone };
    if (form.ambassador_id) body.ambassador_id = form.ambassador_id;
    if (form.status === "scheduled" || form.local) body.scheduled_local = form.local;
    await createPost(body, form.status === "draft" ? "Borrador guardado" : "Post programado");
    setForm((f) => ({ ...f, content: "" }));
  }

  async function quickInOneMinute() {
    await createPost(
      { content: `Post de prueba (${new Date().toLocaleTimeString("es-ES")})`, scheduled_at: new Date(Date.now() + 60_000).toISOString() },
      "Programado para dentro de 1 minuto: mira cómo cambia de estado",
    );
  }

  async function quickBurst() {
    const target = ambassadors.find((a) => a.display_name === "Bruno" || a.display_name === "Diego") ?? ambassadors[0];
    if (!target) return;
    const at = new Date(Date.now() + 3000).toISOString();
    for (let i = 1; i <= 3; i++) {
      await api("/api/v1/posts", {
        method: "POST",
        body: JSON.stringify({ content: `Ráfaga ${i}/3`, ambassador_id: target.id, scheduled_at: at }),
      }).catch(() => undefined);
    }
    notify(`3 posts a la vez para ${target.display_name}: se publicarán espaciados (pacing), no en ráfaga`);
    await refresh();
  }

  async function action(post: Post, kind: "publish" | "cancel") {
    try {
      if (kind === "publish") {
        // One key per click; a network retry of the same click would reuse it.
        await api(`/api/v1/posts/${post.id}/publish`, { method: "POST", headers: { "idempotency-key": crypto.randomUUID() } });
        notify("Enviado a publicar: el worker lo cogerá en segundos");
      } else {
        await api(`/api/v1/posts/${post.id}`, { method: "DELETE" });
        notify("Post cancelado");
      }
      await refresh();
    } catch (err) {
      notify(String(err).replace(/^Error: /, ""), "bad");
    }
  }

  function logout() {
    setToken(storage("ploot_token", ""));
    setTenant(storage("ploot_tenant", "") as "");
    setPosts([]);
    setAmbassadors([]);
  }

  const claims = token ? decodeToken(token) : {};
  const editable = (s: string) => ["draft", "scheduled", "failed"].includes(s);

  return (
    <main>
      <header className="row" style={{ justifyContent: "space-between" }}>
        <div>
          <h1>Ploot · Scheduler de publicación</h1>
          <p className="subtitle">
            Ventana al backend: la API (Next.js) guarda los posts en Postgres y un worker independiente los publica en
            una red social simulada, respetando sus límites.
          </p>
        </div>
        <a className="small" href="https://github.com/Varixx32/Ploot-PruebaTecnica" target="_blank" rel="noreferrer">
          Código en GitHub ↗
        </a>
      </header>

      <section className="card">
        <h2>1 · Elige con quién entrar</h2>
        <div className="grid">
          {DEMO_USERS.map((u) => (
            <div key={u.tenant} className={`user-card ${token && tenant === u.tenant ? "active" : ""}`}>
              <strong>{u.name}</strong>
              <p>{u.blurb}</p>
              <button className={token && tenant === u.tenant ? "" : "primary"} onClick={() => void login(u.tenant)}>
                {token && tenant === u.tenant ? "Sesión activa · volver a entrar" : "Entrar"}
              </button>
            </div>
          ))}
          <div className="user-card">
            <strong>Tu propio JWT</strong>
            <p>Cualquier token HS256 con tenant_id y profile_id firmado con el secreto del servidor.</p>
            <input
              placeholder="Pega un JWT"
              value={token}
              onChange={(e) => {
                setToken(storage("ploot_token", e.target.value));
                setTenant(storage("ploot_tenant", "") as "");
              }}
              style={{ width: "100%" }}
            />
          </div>
        </div>

        {token && (
          <div style={{ marginTop: 14 }}>
            <div className="row small muted" style={{ marginBottom: 6 }}>
              <span>
                tenant_id <span className="mono">{claims.tenant_id ?? "?"}</span>
              </span>
              <span>
                profile_id <span className="mono">{claims.profile_id ?? "?"}</span>
              </span>
              {claims.exp && <span>caduca {relative(new Date(claims.exp * 1000).toISOString(), now)}</span>}
              <button className="small" onClick={logout}>
                Salir
              </button>
            </div>
            <div className="token-box">
              <code className="mono">{token}</code>
              <button
                className="small"
                onClick={() => {
                  void navigator.clipboard.writeText(token);
                  notify("Token copiado al portapapeles");
                }}
              >
                Copiar token
              </button>
            </div>
            <details className="guide small" style={{ marginTop: 8 }}>
              <summary>Usar la API con curl</summary>
              <pre className="code">{`TOKEN=$(curl -s -XPOST ${origin}/api/demo/login -d '{"tenant":"${tenant || "acme"}"}' | jq -r .token)

curl -s ${origin}/api/v1/posts -H "authorization: Bearer $TOKEN"

curl -s -XPOST ${origin}/api/v1/posts -H "authorization: Bearer $TOKEN" \\
  -H 'content-type: application/json' \\
  -d '{"content":"Hola","scheduled_local":"${localInput(new Date(now + 3600_000), "Europe/Madrid")}","timezone":"Europe/Madrid"}'

curl -s -XPOST ${origin}/api/v1/posts/<id>/publish -H "authorization: Bearer $TOKEN" \\
  -H "idempotency-key: $(uuidgen)"`}</pre>
            </details>
          </div>
        )}
      </section>

      {token && (
        <>
          <section className="card">
            <details className="guide">
              <summary>2 · Qué probar (5 minutos)</summary>
              <ol>
                <li>
                  <b>Ciclo completo:</b> pulsa <i>Programar en 1 minuto</i> y observa el post pasar de <i>Programado</i> a{" "}
                  <i>Publicando…</i> y a <i>Publicado</i> (con su id en la red social).
                </li>
                <li>
                  <b>Publicar ahora:</b> en cualquier post programado pulsa <i>Publicar ahora</i>. Es idempotente: un
                  doble clic o un reintento de red no publica dos veces.
                </li>
                <li>
                  <b>Ráfaga controlada:</b> pulsa <i>Ráfaga de 3 posts</i>. No salen a la vez: el worker los espacia por
                  Embajador para proteger su cuenta (columna «Por qué» y tabla de Embajadores).
                </li>
                <li>
                  <b>Tokens:</b> entra como <i>globex</i>: el post de Fede está fallido por token revocado (sin
                  reintentos) y su cola en pausa; los de Elena se publicaron tras refrescar su token caducado.
                </li>
                <li>
                  <b>Aislamiento entre tenants:</b> cada usuario solo ve lo de su tenant; lo garantiza Postgres (RLS), no
                  la interfaz. Copia el id de un post y pídelo con el token del otro tenant: responde 404.
                </li>
                <li>
                  <b>Zonas horarias:</b> programa en <i>Europe/Madrid</i> y en <i>America/New_York</i> a la misma hora
                  local: se guardan como instantes UTC distintos y correctos (también en los cambios de hora).
                </li>
              </ol>
            </details>
          </section>

          <section className="card">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>3 · Crear un post</h2>
              <div className="row">
                <button onClick={() => void quickInOneMinute()}>⚡ Programar en 1 minuto</button>
                <button onClick={() => void quickBurst()}>🚦 Ráfaga de 3 posts</button>
              </div>
            </div>
            <form onSubmit={(e) => void submit(e)} className="form-grid">
              <label>
                Contenido
                <input required placeholder="¿Qué quieres publicar?" value={form.content} onChange={(e) => setForm({ ...form, content: e.target.value })} />
              </label>
              <label>
                Embajador
                <select value={form.ambassador_id} onChange={(e) => setForm({ ...form, ambassador_id: e.target.value })}>
                  <option value="">Yo mismo</option>
                  {ambassadors.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.display_name}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Fecha y hora local
                <input type="datetime-local" value={form.local} onChange={(e) => setForm({ ...form, local: e.target.value })} />
              </label>
              <label>
                Zona horaria
                <select value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })}>
                  {TIMEZONES.map((tz) => (
                    <option key={tz}>{tz}</option>
                  ))}
                </select>
              </label>
              <label>
                Tipo
                <select value={form.status} onChange={(e) => setForm({ ...form, status: e.target.value })}>
                  <option value="scheduled">Programar</option>
                  <option value="draft">Borrador</option>
                </select>
              </label>
              <button type="submit" className="primary">
                Crear
              </button>
            </form>
          </section>

          <section className="card">
            <h2>Embajadores de tu tenant</h2>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Embajador</th>
                    <th>Pendientes ya</th>
                    <th>Publicando</th>
                    <th>Estado de su cola</th>
                    <th>Último intento</th>
                  </tr>
                </thead>
                <tbody>
                  {ambassadors.map((a) => (
                    <tr key={a.id}>
                      <td>
                        <b>{a.display_name}</b>
                      </td>
                      <td>{a.due_now}</td>
                      <td>{a.in_flight}</td>
                      <td>
                        {a.throttle_reason && a.throttled_until ? (
                          <>
                            {THROTTLE[a.throttle_reason] ?? a.throttle_reason}{" "}
                            <span className="muted small">({relative(a.throttled_until, now)})</span>
                          </>
                        ) : (
                          <span className="muted">Libre</span>
                        )}
                      </td>
                      <td className="small">
                        {a.last_outcome ?? <span className="muted">—</span>}
                        {a.last_retry_after_sec ? ` · Retry-After ${a.last_retry_after_sec}s` : ""}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <div className="row" style={{ justifyContent: "space-between", marginBottom: 10 }}>
              <h2 style={{ margin: 0 }}>Posts</h2>
              <label className="row small muted">
                Filtrar
                <select value={filter} onChange={(e) => setFilter(e.target.value)}>
                  <option value="">Todos</option>
                  {Object.entries(STATUS).map(([k, v]) => (
                    <option key={k} value={k}>
                      {v.label}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Estado</th>
                    <th>Embajador</th>
                    <th>Contenido</th>
                    <th>Programado</th>
                    <th>Intentos</th>
                    <th>Por qué</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {posts.length === 0 && (
                    <tr>
                      <td colSpan={7} className="muted">
                        No hay posts {filter ? "con este estado" : "todavía"}.
                      </td>
                    </tr>
                  )}
                  {posts.map((p) => {
                    const s = STATUS[p.status] ?? { label: p.status, color: "#333", bg: "#eee" };
                    const w = why(p, now);
                    return (
                      <tr key={p.id} className={flashIds.has(p.id) ? "flash" : ""}>
                        <td>
                          <span className="badge" style={{ color: s.color, background: s.bg }}>
                            {s.label}
                          </span>
                        </td>
                        <td>{p.ambassador_name}</td>
                        <td style={{ maxWidth: 260 }}>
                          {p.content}
                          <div className="mono muted" title="id del post">
                            {p.id.slice(0, 8)}…
                          </div>
                        </td>
                        <td className="small">
                          {fmt(p.scheduled_at, p.timezone)}
                          <div className="muted">
                            {p.timezone} {p.scheduled_at ? `· ${relative(p.scheduled_at, now)}` : ""}
                          </div>
                        </td>
                        <td>{p.attempts}</td>
                        <td
                          className="small"
                          style={{
                            maxWidth: 320,
                            color: w.tone === "bad" ? "var(--bad)" : w.tone === "ok" ? "var(--ok)" : undefined,
                          }}
                        >
                          {w.text}
                        </td>
                        <td style={{ whiteSpace: "nowrap" }}>
                          {editable(p.status) && (
                            <div className="row">
                              <button className="small" onClick={() => void action(p, "publish")}>
                                Publicar ahora
                              </button>
                              <button className="small" onClick={() => void action(p, "cancel")}>
                                Cancelar
                              </button>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          <section className="card">
            <h2>Transiciones en directo</h2>
            <ul className="timeline small">
              {transitions.length === 0 && <li className="muted">Aquí aparecerá cada cambio de estado que haga el worker.</li>}
              {transitions.map((t, i) => (
                <li key={i}>
                  <span className="mono muted">{t.at}</span> · {t.who} · «{t.post}» · {STATUS[t.from]?.label ?? t.from} →{" "}
                  <b>{STATUS[t.to]?.label ?? t.to}</b>
                </li>
              ))}
            </ul>
          </section>
        </>
      )}

      {toast && <div className={`toast ${toast.tone}`}>{toast.text}</div>}
    </main>
  );
}
