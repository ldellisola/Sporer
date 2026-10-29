import { describe, expect, test, vi } from "vitest";
import { ApiError, deleteJson, getJson, isNotFound, isRefusal, postJson, putJson } from "./client";

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

  test("getJson_throws_ApiError_with_the_status_for_an_error_body_that_is_not_JSON", async () => {
    // A proxy or a gateway answers in HTML: the status is what the caller needs, and there is no JSON to read.
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));

    const failure = await getJson("/api/day/2026-10-22").then(
      () => null,
      (error: unknown) => error,
    );

    expect(failure).toBeInstanceOf(ApiError);
    expect((failure as ApiError).status).toBe(502);
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

/** The one request the stubbed `fetch` was given: its URL and its options, with the headers read the way the browser would send them. */
function sent(fetchMock: ReturnType<typeof vi.fn>) {
  const [url, init] = (fetchMock.mock.calls[0] ?? []) as [string, RequestInit | undefined];
  const headers = new Headers(init?.headers);
  return { url, method: init?.method, body: init?.body, contentType: headers.get("Content-Type"), accept: headers.get("Accept") };
}

describe("postJson, putJson and deleteJson", () => {
  test("the_write_helpers_send_their_method_to_the_path_as_json_and_return_the_parsed_answer", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond(200, { retried: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postJson<{ retried: number }>("/api/status/retry", { a: 1 })).resolves.toEqual({ retried: 2 });
    expect(sent(fetchMock)).toEqual({ url: "/api/status/retry", method: "POST", body: '{"a":1}', contentType: "application/json", accept: "application/json" });

    fetchMock.mockClear();
    await expect(putJson<{ retried: number }>("/api/settings", { tripMinDistanceKm: 80 })).resolves.toEqual({ retried: 2 });
    expect(sent(fetchMock)).toEqual({
      url: "/api/settings",
      method: "PUT",
      body: '{"tripMinDistanceKm":80}',
      contentType: "application/json",
      accept: "application/json",
    });
  });

  test("a_write_without_a_body_still_says_it_is_json_and_a_post_or_put_sends_an_empty_object", async () => {
    // The API refuses a write that does not say it is JSON (a cross-site form could send one), body or not: P4-R4.
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond(200, {}));
    vi.stubGlobal("fetch", fetchMock);

    await postJson("/api/status/retry");
    expect(sent(fetchMock)).toMatchObject({ method: "POST", body: "{}", contentType: "application/json" });

    fetchMock.mockClear();
    await putJson("/api/x");
    expect(sent(fetchMock)).toMatchObject({ method: "PUT", body: "{}", contentType: "application/json" });

    fetchMock.mockClear();
    vi.stubGlobal("fetch", fetchMock.mockImplementation(async () => new Response(null, { status: 204 })));
    await deleteJson("/api/trips/2026-09-12");
    expect(sent(fetchMock)).toMatchObject({ url: "/api/trips/2026-09-12", method: "DELETE", body: undefined, contentType: "application/json" });
  });

  test("a_write_that_the_server_answers_with_no_content_resolves_to_undefined", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 204 })));

    await expect(deleteJson("/api/trips/2026-09-12")).resolves.toBeUndefined();
    await expect(postJson("/api/trips/deleted/2026-09-12/restore")).resolves.toBeUndefined();
  });

  test("the_write_helpers_throw_ApiError_with_the_status_and_name_the_method", async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ["POST", () => postJson("/api/places/7/merge", { into: 2 })],
      ["PUT", () => putJson("/api/trips/2026-09-12", { name: "x" })],
      ["DELETE", () => deleteJson("/api/homes/3")],
    ];
    for (const [method, call] of calls) {
      for (const status of [400, 404, 409, 415, 500]) {
        vi.stubGlobal("fetch", vi.fn(async () => respond(status, { title: "nope" })));

        const failure = await call().then(
          () => null,
          (error: unknown) => error,
        );

        expect(failure, `${method} ${status}`).toBeInstanceOf(ApiError);
        expect((failure as ApiError).status).toBe(status);
        expect((failure as ApiError).message).toContain(`${method} /api/`);
        expect((failure as ApiError).message).toContain(String(status));
      }
    }
  });

  test("the_write_helpers_throw_ApiError_with_the_status_for_an_error_body_that_is_not_JSON", async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ["POST", () => postJson("/api/places/7/merge", { place: 2, name: null })],
      ["PUT", () => putJson("/api/places/7/name", { name: null })],
      ["DELETE", () => deleteJson("/api/places/7/merged/2")],
    ];
    for (const [method, call] of calls) {
      vi.stubGlobal("fetch", vi.fn(async () => new Response("<html>", { status: 502 })));

      const failure = await call().then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure, method).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(502);
      expect((failure as ApiError).message).toContain(`${method} /api/`);
    }
  });

  test("the_write_helpers_reject_when_the_request_never_gets_an_answer", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    await expect(postJson("/api/x", {})).rejects.toBeInstanceOf(TypeError);
    await expect(putJson("/api/x", {})).rejects.toBeInstanceOf(TypeError);
    await expect(deleteJson("/api/x")).rejects.toBeInstanceOf(TypeError);
  });
});

describe("ApiError detail", () => {
  // The API's error body (FastEndpoints): what is wrong, by field. The first message is what a control shows as it is; it is never branched on.
  const refusal = { statusCode: 409, message: "One or more errors occurred!", errors: { place: ["The place is the one it is to be merged into."] } };

  test("a_read_and_every_write_that_the_API_refuses_carry_the_first_message_of_its_error_body", async () => {
    const calls: [string, () => Promise<unknown>][] = [
      ["GET", () => getJson("/api/places/7")],
      ["POST", () => postJson("/api/places/7/merge", { place: 2, name: null })],
      ["PUT", () => putJson("/api/places/7/name", { name: null })],
      ["DELETE", () => deleteJson("/api/places/7/merged/2")],
    ];
    for (const [method, call] of calls) {
      vi.stubGlobal("fetch", vi.fn(async () => respond(409, refusal)));

      const failure = await call().then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure, method).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(409);
      expect((failure as ApiError).detail).toBe("The place is the one it is to be merged into.");
      expect((failure as ApiError).message).toMatch(new RegExp(`^${method} /api/places/7\\S* failed with status 409$`)); // the message is still the status's
    }
  });

  test("a_body_that_is_not_the_APIs_shape_gives_no_detail_and_still_the_status", async () => {
    const bodies: (string | object)[] = ["<html>", "", {}, { title: "nope" }, { errors: null }, { errors: {} }, { errors: { place: [] } }, { errors: { place: [7] } }, { errors: [1] }, []];
    for (const body of bodies) {
      vi.stubGlobal("fetch", vi.fn(async () => (typeof body === "string" ? new Response(body, { status: 502 }) : respond(502, body))));

      const failure = await postJson("/api/x").then(
        () => null,
        (error: unknown) => error,
      );

      expect(failure, JSON.stringify(body)).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status).toBe(502);
      expect((failure as ApiError).detail, JSON.stringify(body)).toBeNull();
    }
  });

  test("a_body_that_was_read_already_gives_no_detail_and_still_the_status", async () => {
    const used = respond(500, refusal);
    await used.text(); // as a mock that hands the same response to every request would
    vi.stubGlobal("fetch", vi.fn(async () => used));

    const failure = await getJson("/api/x").then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as ApiError).status).toBe(500);
    expect((failure as ApiError).detail).toBeNull();
  });

  test("the_first_message_of_the_first_field_that_has_one_is_the_detail", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => respond(400, { errors: { id: [], name: ["The name is missing.", "Another."] } })));

    const failure = await putJson("/api/places/7/name", {}).then(
      () => null,
      (error: unknown) => error,
    );

    expect((failure as ApiError).detail).toBe("The name is missing.");
  });

  test("an_ApiError_made_by_hand_has_no_detail_unless_it_is_given_one", () => {
    expect(new ApiError(404, "/api/places/9").detail).toBeNull();
    expect(new ApiError(409, "/api/places/9/merge", "POST", "Why.").detail).toBe("Why.");
  });
});

describe("ApiError", () => {
  test("ApiError_names_a_GET_unless_it_is_told_the_method", () => {
    expect(new ApiError(404, "/api/places/9").message).toBe("GET /api/places/9 failed with status 404");
    expect(new ApiError(409, "/api/places/9/merge", "POST").message).toBe("POST /api/places/9/merge failed with status 409");
  });
});

describe("isNotFound", () => {
  test("isNotFound_is_true_for_a_404_of_the_api_and_for_nothing_else", () => {
    expect(isNotFound(new ApiError(404, "/api/places/9"))).toBe(true);
    for (const status of [400, 403, 500, 503]) expect(isNotFound(new ApiError(status, "/api/places/9")), String(status)).toBe(false);
    expect(isNotFound(new Error("GET /api/places/9 failed with status 404"))).toBe(false); // the words of a message are not a status
    expect(isNotFound(new TypeError("Failed to fetch"))).toBe(false);
    expect(isNotFound(null)).toBe(false);
    expect(isNotFound(undefined)).toBe(false);
    expect(isNotFound({ status: 404 })).toBe(false);
  });
});

describe("isRefusal", () => {
  test("isRefusal_is_true_for_a_400_a_404_and_a_409_of_the_api_and_for_nothing_else", () => {
    // The server refused the request itself: sent again it is refused again, so there is no use in offering to send it again.
    for (const status of [400, 404, 409]) expect(isRefusal(new ApiError(status, "/api/places/9/merge", "POST")), String(status)).toBe(true);
    for (const status of [401, 403, 415, 500, 502, 503]) expect(isRefusal(new ApiError(status, "/api/places/9/merge", "POST")), String(status)).toBe(false);
    expect(isRefusal(new Error("POST /api/places/9/merge failed with status 409"))).toBe(false); // the words of a message are not a status
    expect(isRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isRefusal({ status: 409 })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });
});
