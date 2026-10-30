import type { resolveLlm } from "../../llm/adapter.js";
import type { GenerateRequest, LlmClient } from "../../llm/schema.js";

/**
 * What init fetches and asks Claude, kept across the runs that going back starts (util/replay),
 * so a replay neither repeats a request nor gets another answer than the first time.
 *
 * Entries are keyed by the request and by how many times this run has made it: a run that makes
 * the same request twice (a check retried later) still gets each answer in turn, as the first
 * run did.
 */
export interface InitCache {
  /** Called before each run, so occurrences are counted from the start again. */
  newRun(): void;
  resolveLlm: typeof resolveLlm;
  /** Replaces the global fetch until the returned function is called. */
  installFetch(): () => void;
  /** Stops the Claude lookup if it is still going. */
  close(): void;
}

interface Stored {
  status: number;
  statusText: string;
  headers: [string, string][];
  url: string;
  body: ArrayBuffer;
}

export function createInitCache(resolve: typeof resolveLlm, signal?: AbortSignal): InitCache {
  const counts = new Map<string, number>();
  const occurrence = (key: string) => {
    const n = counts.get(key) ?? 0;
    counts.set(key, n + 1);
    return `${n}\u0000${key}`;
  };
  const answers = new Map<string, Promise<unknown>>();
  const responses = new Map<string, Promise<Stored>>();
  // Not the run's own signal: a run that goes back stops its lookup, which the next run reuses.
  const lookup = new AbortController();
  let resolved: ReturnType<typeof resolveLlm> | undefined;

  const cachedClient = (client: LlmClient): LlmClient => ({
    ...client,
    generate<T>(req: GenerateRequest<T>, opts?: { signal?: AbortSignal }): Promise<T> {
      const key = occurrence(`llm\u0000${req.tier}\u0000${req.system}\u0000${req.prompt}`);
      let answer = answers.get(key);
      if (!answer) {
        answer = client.generate(req, opts);
        answers.set(key, answer);
      }
      return answer as Promise<T>;
    },
  });

  return {
    newRun: () => counts.clear(),
    resolveLlm: (settings, opts) => {
      resolved ??= resolve(settings, {
        ...opts,
        signal: signal ? AbortSignal.any([signal, lookup.signal]) : lookup.signal,
      }).then((r) => ({ ...r, client: cachedClient(r.client) }));
      return resolved;
    },
    installFetch() {
      const real = globalThis.fetch;
      globalThis.fetch = async (input, init) => {
        const url = input instanceof Request ? input.url : String(input);
        const body = typeof init?.body === "string" ? init.body : "";
        const key = occurrence(`fetch\u0000${init?.method ?? "GET"}\u0000${url}\u0000${body}`);
        let stored = responses.get(key);
        if (!stored) {
          stored = real(input, init).then(async (res) => ({
            status: res.status,
            statusText: res.statusText,
            headers: [...res.headers],
            url: res.url,
            body: await readCapped(res),
          }));
          responses.set(key, stored);
        }
        const s = await stored;
        const res = new Response(nullBody(s.status) ? null : s.body.slice(0), {
          status: s.status,
          statusText: s.statusText,
          headers: s.headers,
        });
        // A Response made here has no URL; callers read it for where redirects ended.
        Object.defineProperty(res, "url", { value: s.url });
        return res;
      };
      return () => {
        globalThis.fetch = real;
      };
    },
    close: () => lookup.abort(),
  };
}

// More than any limit util/http sets, so a body past one is still seen to be past it there; an
// endless body is not buffered forever.
const MAX_BUFFERED = 16 * 1024 * 1024 + 1;

async function readCapped(res: Response): Promise<ArrayBuffer> {
  if (!res.body) return new ArrayBuffer(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    length += value.length;
    if (length >= MAX_BUFFERED) {
      await reader.cancel();
      break;
    }
  }
  const out = new Uint8Array(length);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out.buffer;
}

function nullBody(status: number): boolean {
  return status === 101 || status === 204 || status === 205 || status === 304;
}
