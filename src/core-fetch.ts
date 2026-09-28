export const CORE_TIMEOUT_MS = 2000;

export const coreFetch = (
  base: string,
  path: string,
  init?: RequestInit,
): Promise<Response> =>
  fetch(`${base}${path}`, {
    ...init,
    signal: AbortSignal.timeout(CORE_TIMEOUT_MS),
  });
