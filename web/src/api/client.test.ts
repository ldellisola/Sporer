import { describe, expect, test, vi } from "vitest";
import { ApiError, getJson } from "./client";

function respond(status: number, body: unknown = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("getJson", () => {
  test("getJson_throws_ApiError_with_status", async () => {
    for (const status of [400, 404, 500, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => respond(status, { title: "nope" })));

      const failure = await getJson("/api/day/2026-10-22").then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure).toBeInstanceOf(ApiError);
      expect(failure).toBeInstanceOf(Error);
      expect((failure as ApiError).status).toBe(status);
      expect((failure as ApiError).message).toContain(String(status));
      expect((failure as ApiError).message).toContain("/api/day/2026-10-22");
    }
  });

  test("getJson_returns_the_parsed_body_and_passes_the_signal_on", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond(200, { mapStyleLight: "a" }));
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();

    const body = await getJson<{ mapStyleLight: string }>("/api/config", controller.signal);

    expect(body).toEqual({ mapStyleLight: "a" });
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe("/api/config");
    expect(init?.signal).toBe(controller.signal);
    expect(new Headers(init?.headers).get("Accept")).toBe("application/json");
  });

  test("getJson_works_without_a_signal", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(200, [1, 2])));

    await expect(getJson<number[]>("/api/x")).resolves.toEqual([1, 2]);
  });

  test("getJson_rejects_when_the_request_is_aborted_and_when_the_network_fails", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        throw new TypeError("Failed to fetch");
      }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(getJson("/api/x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });
    await expect(getJson("/api/x")).rejects.toBeInstanceOf(TypeError);
  });
});
