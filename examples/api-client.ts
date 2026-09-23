// Copy into frontend/src/api.ts. No backend or AI secrets belong here.
// dev: new QorApi("http://127.0.0.1:8000"); production: new QorApi("").
export class QorApi {
  private pendingSession?: Promise<string>;
  constructor(private base = "") {}

  async session(): Promise<string> {
    const saved = sessionStorage.getItem("qor-token");
    if (saved) return saved;
    if (!this.pendingSession) {
      this.pendingSession = fetch(`${this.base}/api/sessions`, { method: "POST" })
        .then(async r => {
          if (!r.ok) throw new Error("Не удалось создать сессию");
          const { token } = await r.json();
          sessionStorage.setItem("qor-token", token);
          return token as string;
        }).finally(() => { this.pendingSession = undefined; });
    }
    return this.pendingSession;
  }

  private async response(path: string, init: RequestInit = {}): Promise<Response> {
    const headers = new Headers(init.headers);
    headers.set("Authorization", `Bearer ${await this.session()}`);
    const r = await fetch(`${this.base}${path}`, { ...init, headers });
    if (!r.ok) {
      const problem = await r.json().catch(() => null);
      throw Object.assign(new Error(problem?.error?.message ?? `HTTP ${r.status}`), {
        status: r.status, code: problem?.error?.code, fields: problem?.error?.fields,
      });
    }
    return r;
  }

  async json<T>(path: string, method = "GET", body?: unknown): Promise<T> {
    const r = await this.response(path, {
      method,
      headers: body === undefined ? {} : { "Content-Type": "application/json" },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r.json();
  }

  async importFiles(files: File[], fields: Record<string, string>, adminToken: string) {
    const form = new FormData();
    files.forEach(file => form.append("files", file));
    Object.entries(fields).forEach(([key, value]) => form.append(key, value));
    const r = await this.response("/api/imports", {
      method: "POST", headers: { "X-Admin-Token": adminToken }, body: form,
    });
    return r.json();
  }

  async downloadApprovedOrder(id: string): Promise<void> {
    const r = await this.response(`/api/orders/${encodeURIComponent(id)}/export.csv`);
    const url = URL.createObjectURL(await r.blob());
    const a = document.createElement("a");
    a.href = url;
    a.download = `qor-order-${id}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

// Example:
// const api = new QorApi("http://127.0.0.1:8000");
// const run = await api.json<{run_id: string}>("/api/runs", "POST", {
//   dataset_id: "demo-engine-v1", supplier_id: "systeme_electric", as_of: "2026-09-22"
// });
// const page = await api.json(`/api/runs/${run.run_id}/recommendations`);
