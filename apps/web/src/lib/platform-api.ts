import type {
  AssetEntry,
  ConfigParam,
  ProjectDetail,
  ProjectSummary,
  ReleaseCard,
  ReleasePlayPayload,
  UploadAssetResponse,
  UserProfile,
} from "@aa-game/protocol";

export const API_BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:4002";
const TOKEN_KEY = "aa-game-session-token";

export function getStoredToken(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

export function setStoredToken(token: string | null): void {
  if (typeof window === "undefined") return;
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch {
    // ignore
  }
}

async function apiFetch<T>(pathname: string, init?: RequestInit): Promise<T> {
  const token = getStoredToken();
  const res = await fetch(`${API_BASE_URL}${pathname}`, {
    ...init,
    headers: {
      ...(init?.body ? { "content-type": "application/json" } : {}),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init?.headers ?? {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error((data as { error?: string }).error || `HTTP ${res.status}`);
  }
  return data as T;
}

export const platformApi = {
  health: () => apiFetch<{ ok: boolean; dbOk: boolean; s3Ok: boolean; lanIp: string }>("/health"),
  me: () => apiFetch<{ user: UserProfile | null }>("/api/auth/me"),
  register: async (username: string, password: string, displayName?: string) => {
    const res = await apiFetch<{ user: UserProfile; token: string }>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password, displayName }),
    });
    setStoredToken(res.token);
    return res.user;
  },
  login: async (username: string, password: string) => {
    const res = await apiFetch<{ user: UserProfile; token: string }>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    });
    setStoredToken(res.token);
    return res.user;
  },
  demoLogin: async () => {
    const res = await apiFetch<{ user: UserProfile; token: string }>("/api/auth/demo", {
      method: "POST",
    });
    setStoredToken(res.token);
    return res.user;
  },
  logout: async () => {
    await apiFetch("/api/auth/logout", { method: "POST" }).catch(() => {});
    setStoredToken(null);
  },

  listProjects: () => apiFetch<{ projects: ProjectSummary[] }>("/api/projects"),
  createProject: (params: {
    title: string;
    description?: string;
    templateId?: string;
    files?: Record<string, string>;
    configSchema?: ConfigParam[];
  }) =>
    apiFetch<{ project: ProjectDetail }>("/api/projects", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  getProject: (id: string) => apiFetch<{ project: ProjectDetail }>(`/api/projects/${id}`),
  saveSnapshot: (
    projectId: string,
    params: {
      files: Record<string, string>;
      commitSummary: string;
      title?: string;
      description?: string;
      configSchema?: ConfigParam[];
    },
  ) =>
    apiFetch<{ snapshotId: string; project: ProjectDetail }>(`/api/projects/${projectId}/snapshots`, {
      method: "POST",
      body: JSON.stringify(params),
    }),
  rollbackSnapshot: (projectId: string, snapshotId: string) =>
    apiFetch<{ project: ProjectDetail }>(`/api/projects/${projectId}/rollback`, {
      method: "POST",
      body: JSON.stringify({ snapshotId }),
    }),
  publishProject: (
    projectId: string,
    params: {
      title?: string;
      description?: string;
      isPublic: boolean;
      clientBundle?: string;
      simBundle?: string;
      files?: Record<string, string>;
      configSchema?: ConfigParam[];
    },
  ) =>
    apiFetch<{
      release: ReleaseCard;
      clientBundleUrl: string | null;
      roomBundleUrl: string | null;
      lanIp: string;
    }>(`/api/projects/${projectId}/publish`, {
      method: "POST",
      body: JSON.stringify(params),
    }),

  listReleases: (query?: { mode?: string; q?: string; sort?: string }) => {
    const params = new URLSearchParams();
    if (query?.mode && query.mode !== "all") params.set("mode", query.mode);
    if (query?.q) params.set("q", query.q);
    if (query?.sort) params.set("sort", query.sort);
    const qs = params.toString();
    return apiFetch<{ releases: ReleaseCard[] }>(`/api/releases${qs ? `?${qs}` : ""}`);
  },
  getRelease: (slug: string) => apiFetch<ReleasePlayPayload>(`/api/releases/${encodeURIComponent(slug)}`),
  toggleLike: (slug: string) =>
    apiFetch<{ liked: boolean; release: ReleaseCard }>(`/api/releases/${encodeURIComponent(slug)}/like`, {
      method: "POST",
    }),
  remixRelease: (slug: string) =>
    apiFetch<{ project: ProjectDetail }>(`/api/releases/${encodeURIComponent(slug)}/remix`, {
      method: "POST",
    }),

  uploadAsset: (params: {
    filename: string;
    mimeType: string;
    dataBase64: string;
    assetId?: string;
    kind?: AssetEntry["kind"];
  }) =>
    apiFetch<UploadAssetResponse>("/api/assets/upload", {
      method: "POST",
      body: JSON.stringify(params),
    }),
  generateSprite: (params: {
    prompt: string;
    assetId?: string;
    style: "neon" | "pixel" | "cartoon";
    removeBg: boolean;
    apiKey?: string;
    baseUrl?: string;
    model?: string;
  }) =>
    apiFetch<UploadAssetResponse & { usedExternalApi: boolean }>("/api/assets/generate", {
      method: "POST",
      body: JSON.stringify(params),
    }),

  downloadExport: async (kind: "html" | "zip", title: string, files: Record<string, string>) => {
    const res = await fetch(`${API_BASE_URL}/api/export/${kind}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, files }),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error((data as { error?: string }).error || `导出失败 (${res.status})`);
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safe = title.replace(/[^a-zA-Z0-9_-]+/g, "-").toLowerCase().slice(0, 32) || "aa-game";
    a.href = url;
    a.download = `${safe}.${kind}`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  },
};
