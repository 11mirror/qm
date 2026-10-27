import { swallow } from "../../../chassis/src/errors";

export type Api = (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; status: number; data: any }>;

export function adminApi(base: string): Api {
  return async (method, path, body) => {
    try {
      const res = await fetch(base + path.replace(/^\/api(?=\/)/, ""), {
        method,
        headers: body ? { "content-type": "application/json" } : {},
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const text = await res.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch (error) {
        swallow(`admin api: non-JSON response ${method} ${path} ${res.status}`, error);
      }
      return { ok: res.ok, status: res.status, data };
    } catch (error) {
      swallow(`admin api: request failed ${method} ${path}`, error);
      return { ok: false, status: 0, data: { message: "Network request failed." } };
    }
  };
}

export const scopeUrl = (id: string, rest = "") => "/api/scopes/" + encodeURIComponent(id) + rest;

export const viewUrl = (id: string, name: string) => scopeUrl(id, "?view=" + encodeURIComponent(name));
