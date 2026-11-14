import type { Supervisor } from "./supervisor";

/** AbortSignal that fires after a delay (AbortSignal.timeout is missing from the lib types here). */
export function timeoutSignal(ms: number): AbortSignal {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  timer.unref?.();
  return controller.signal;
}

/** Authenticated call to the running voicekit server. */
export async function voicekit(supervisor: Supervisor, path: string, init: RequestInit & { timeoutMs?: number } = {}): Promise<Response> {
  const port = supervisor.state.port;
  const token = supervisor.token;
  if (!port || !token) throw new Error("The Voice Kit server is not running.");
  const { timeoutMs = 15_000, headers, ...rest } = init;
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...rest,
    headers: { authorization: `Bearer ${token}`, ...(headers as Record<string, string> | undefined) },
    signal: timeoutSignal(timeoutMs),
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    try {
      const body = (await response.json()) as { error?: { message?: string } };
      if (body.error?.message) message = body.error.message;
    } catch {
      // Not JSON.
    }
    throw new Error(message);
  }
  return response;
}

export async function voicekitJson<T>(supervisor: Supervisor, path: string, init?: RequestInit & { timeoutMs?: number }): Promise<T> {
  return (await (await voicekit(supervisor, path, init)).json()) as T;
}
