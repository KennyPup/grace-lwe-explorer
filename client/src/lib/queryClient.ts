import { QueryClient, QueryFunction } from "@tanstack/react-query";

const API_BASE = "";

// ---------------------------------------------------------------------------
// Timeout + retry helpers (cold-start resilience for Render free tier)
// ---------------------------------------------------------------------------
const FETCH_TIMEOUT_MS = 60_000; // 60 s — gives Render enough time to wake up

/**
 * fetch() wrapper that aborts after `timeoutMs` milliseconds.
 */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init?: RequestInit,
  timeoutMs = FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Returns true for error conditions that are safe to retry (cold-start
 * gateway errors, network blip, or abort from our own timeout).
 */
export function isRetryableError(e: unknown): boolean {
  if (e instanceof Error) {
    const msg = e.message;
    // Our own timeout abort
    if (e.name === "AbortError") return true;
    // HTTP gateway / server errors encoded in the message by throwIfResNotOk
    if (/^(502|503|504):/.test(msg)) return true;
    // Network-level failures
    if (msg.includes("Failed to fetch") || msg.includes("NetworkError")) return true;
  }
  return false;
}

async function throwIfResNotOk(res: Response) {
  if (!res.ok) {
    const text = (await res.text()) || res.statusText;
    throw new Error(`${res.status}: ${text}`);
  }
}

export async function apiRequest(
  method: string,
  url: string,
  data?: unknown | undefined,
): Promise<Response> {
  const res = await fetchWithTimeout(`${API_BASE}${url}`, {
    method,
    headers: data ? { "Content-Type": "application/json" } : {},
    body: data ? JSON.stringify(data) : undefined,
  });

  await throwIfResNotOk(res);
  return res;
}

type UnauthorizedBehavior = "returnNull" | "throw";
export const getQueryFn: <T>(options: {
  on401: UnauthorizedBehavior;
}) => QueryFunction<T> =
  ({ on401: unauthorizedBehavior }) =>
  async ({ queryKey }) => {
    const res = await fetch(`${API_BASE}${queryKey.join("/")}`);

    if (unauthorizedBehavior === "returnNull" && res.status === 401) {
      return null;
    }

    await throwIfResNotOk(res);
    return await res.json();
  };

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      queryFn: getQueryFn({ on401: "throw" }),
      refetchInterval: false,
      refetchOnWindowFocus: false,
      staleTime: Infinity,
      retry: false,
    },
    mutations: {
      retry: false,
    },
  },
});
