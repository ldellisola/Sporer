import { afterEach, describe, expect, test, vi } from "vitest";
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
    expect(init?.redirect).toBe("manual"); // a redirect is the login's, and is looked at, not followed (see "signed out" below)
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
  return { url, method: init?.method, body: init?.body, contentType: headers.get("Content-Type"), accept: headers.get("Accept"), redirect: init?.redirect };
}

describe("postJson, putJson and deleteJson", () => {
  test("the_write_helpers_send_their_method_to_the_path_as_json_and_return_the_parsed_answer", async () => {
    const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond(200, { retried: 2 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(postJson<{ retried: number }>("/api/status/retry", { a: 1 })).resolves.toEqual({ retried: 2 });
    expect(sent(fetchMock)).toEqual({
      url: "/api/status/retry",
      method: "POST",
      body: '{"a":1}',
      contentType: "application/json",
      accept: "application/json",
      redirect: "manual",
    });

    fetchMock.mockClear();
    await expect(putJson<{ retried: number }>("/api/settings", { tripMinDistanceKm: 80 })).resolves.toEqual({ retried: 2 });
    expect(sent(fetchMock)).toEqual({
      url: "/api/settings",
      method: "PUT",
      body: '{"tripMinDistanceKm":80}',
      contentType: "application/json",
      accept: "application/json",
      redirect: "manual",
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
    expect(sent(fetchMock)).toMatchObject({ url: "/api/trips/2026-09-12", method: "DELETE", body: undefined, contentType: "application/json", redirect: "manual" });
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
  test("isRefusal_is_true_for_every_4xx_of_the_api_except_a_408_and_a_429_and_for_nothing_else", () => {
    // The server refused the request itself: sent again it is refused again, so there is no use in offering to send it again (P4-R29).
    for (const status of [400, 401, 403, 404, 409, 410, 413, 415, 422, 451, 499])
      expect(isRefusal(new ApiError(status, "/api/places/9/merge", "POST")), String(status)).toBe(true);
    // A request that timed out and one that was told to wait may pass when sent again, as a 5xx or a dropped connection may.
    for (const status of [408, 429, 500, 502, 503, 504]) expect(isRefusal(new ApiError(status, "/api/places/9/merge", "POST")), String(status)).toBe(false);
    for (const status of [200, 204, 304, 399]) expect(isRefusal(new ApiError(status, "/api/places/9/merge", "POST")), String(status)).toBe(false);
    expect(isRefusal(new Error("POST /api/places/9/merge failed with status 409"))).toBe(false); // the words of a message are not a status
    expect(isRefusal(new TypeError("Failed to fetch"))).toBe(false);
    expect(isRefusal({ status: 409 })).toBe(false);
    expect(isRefusal(null)).toBe(false);
  });

  test("isRefusal_is_false_for_the_error_of_a_redirect_which_is_a_status_of_0_and_is_offered_a_Retry", () => {
    // The signed-out answer (an opaque redirect) has no status of its own: 0. It is not the server refusing a request: after the owner has
    // signed in again it is sent as it was.
    expect(isRefusal(new ApiError(0, "/api/day/2026-10-22"))).toBe(false);
    expect(isRefusal(new ApiError(0, "/api/places/9/merge", "POST"))).toBe(false);
  });
});

describe("signed out", () => {
  // What the browser gives for a request made with `redirect: "manual"` that the server answered with a redirect (the login of a proxy in front of the
  // app, say): a response of type `opaqueredirect`, with the status 0 and nothing in it. A `Response` cannot be made like it, so it is made by hand.
  function opaqueRedirect(): Response {
    const response = new Response(null);
    Object.defineProperties(response, { type: { value: "opaqueredirect" }, status: { value: 0 }, ok: { value: false } });
    return response;
  }

  const calls: [string, () => Promise<unknown>][] = [
    ["GET", () => getJson("/api/day/2026-10-22")],
    ["POST", () => postJson("/api/status/retry")],
    ["PUT", () => putJson("/api/settings", { tripMinDistanceKm: 80 })],
    ["DELETE", () => deleteJson("/api/trips/2026-09-12")],
  ];

  const fail = (call: () => Promise<unknown>): Promise<unknown> =>
    call().then(
      () => null,
      (error: unknown) => error,
    );

  let reload = vi.fn();

  /** A page whose `location.reload` is counted (jsdom's does not navigate), and whose clock is at `iso`. */
  function pageAt(iso: string): void {
    reload = vi.fn();
    vi.stubGlobal("location", { ...window.location, reload });
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(iso));
  }

  const later = (ms: number): void => void vi.setSystemTime(Date.now() + ms);

  afterEach(() => {
    vi.restoreAllMocks(); // a test that broke the storage must not break the clearing of it
    vi.useRealTimers();
    window.sessionStorage.clear();
  });

  test("every_request_asks_for_a_redirect_to_be_handed_over_and_not_followed", async () => {
    pageAt("2026-10-22T12:00:00Z");
    for (const [method, call] of calls) {
      const fetchMock = vi.fn(async (..._args: Parameters<typeof fetch>) => respond(200, {}));
      vi.stubGlobal("fetch", fetchMock);

      await call();

      expect(fetchMock.mock.calls[0]?.[1]?.redirect, method).toBe("manual");
    }
  });

  test("a_redirect_reloads_the_page_once_and_fails_the_call_with_an_ApiError_of_status_0", async () => {
    for (const [method, call] of calls) {
      pageAt("2026-10-22T12:00:00Z");
      window.sessionStorage.clear();
      vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

      const failure = await fail(call);

      expect(failure, method).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status, method).toBe(0);
      expect((failure as ApiError).message, method).toMatch(new RegExp(`^${method} /api/\\S+ failed with status 0$`));
      expect(isRefusal(failure), method).toBe(false); // a Retry is offered
      expect(reload, method).toHaveBeenCalledTimes(1);
    }
  });

  test("a_second_redirect_within_60_seconds_does_not_reload_again_and_still_fails_the_call", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

    await fail(calls[0]![1]);
    later(1_000);
    const second = await fail(calls[1]![1]);
    later(58_998); // 59.998 s after the first
    const third = await fail(calls[0]![1]);
    later(1); // 59.999 s
    await fail(calls[0]![1]);

    expect(reload).toHaveBeenCalledTimes(1);
    expect(second).toBeInstanceOf(ApiError);
    expect((second as ApiError).status).toBe(0);
    expect((third as ApiError).status).toBe(0);
  });

  test("a_redirect_after_60_seconds_reloads_again", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

    await fail(calls[0]![1]);
    later(60_000);
    await fail(calls[0]![1]);
    expect(reload).toHaveBeenCalledTimes(2);

    later(30_000); // the time to count from is the last reload's, not the first's
    await fail(calls[0]![1]);
    expect(reload).toHaveBeenCalledTimes(2);
    later(30_000);
    await fail(calls[0]![1]);
    expect(reload).toHaveBeenCalledTimes(3);
  });

  test("redirects_that_come_together_reload_once", async () => {
    // A view asks for several things at once, and each of them is answered with the redirect.
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

    await Promise.all(calls.map(([, call]) => fail(call)));

    expect(reload).toHaveBeenCalledTimes(1);
  });

  test("the_time_of_the_last_reload_is_kept_for_the_tab_in_sessionStorage_and_not_in_localStorage", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

    await fail(calls[0]![1]);

    expect(window.sessionStorage.length).toBe(1);
    expect(window.localStorage.length).toBe(0);
    expect(Number(window.sessionStorage.getItem(window.sessionStorage.key(0)!))).toBe(Date.parse("2026-10-22T12:00:00Z"));
  });

  test("something_in_sessionStorage_that_is_not_a_time_counts_as_no_reload_yet", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));
    await fail(calls[0]![1]);
    const key = window.sessionStorage.key(0)!;

    for (const garbage of ["banana", "", "NaN", "Infinity", "-1"]) {
      reload.mockClear();
      window.sessionStorage.setItem(key, garbage);
      await fail(calls[0]![1]);
      expect(reload, JSON.stringify(garbage)).toHaveBeenCalledTimes(1);
    }
  });

  test("a_time_in_the_future_does_not_hold_the_reload_back", async () => {
    // The clock was set back since: waiting for a time that is a day away would be no reload for a day.
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));
    await fail(calls[0]![1]);
    window.sessionStorage.setItem(window.sessionStorage.key(0)!, String(Date.now() + 86_400_000));
    reload.mockClear();

    await fail(calls[0]![1]);

    expect(reload).toHaveBeenCalledTimes(1);
  });

  describe("sessionStorage_that_throws_counts_as_never_reloaded", () => {
    const failures: [string, () => void][] = [
      [
        "getItem and setItem",
        () => {
          vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
            throw new DOMException("The operation is insecure.", "SecurityError");
          });
          vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new DOMException("The quota has been exceeded.", "QuotaExceededError");
          });
        },
      ],
      [
        "the sessionStorage property",
        () => {
          vi.spyOn(window, "sessionStorage", "get").mockImplementation(() => {
            throw new DOMException("The operation is insecure.", "SecurityError");
          });
        },
      ],
    ];

    test.each(failures)("%s", async (_name, breakStorage) => {
      pageAt("2026-10-22T12:00:00Z");
      breakStorage();
      vi.stubGlobal("fetch", vi.fn(async () => opaqueRedirect()));

      const failure = await fail(calls[0]![1]);
      later(1_000);
      await fail(calls[0]![1]);

      expect(failure).toBeInstanceOf(ApiError); // no throw of the storage's reaches the caller
      expect((failure as ApiError).status).toBe(0);
      expect(reload).toHaveBeenCalledTimes(2); // nothing says it has reloaded
    });
  });

  test("a_network_error_never_reloads_and_is_the_error_it_was", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new TypeError("Failed to fetch"))));

    for (const [method, call] of calls) {
      const failure = await fail(call);
      expect(failure, method).toBeInstanceOf(TypeError);
    }

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  });

  test("an_aborted_read_never_reloads", async () => {
    pageAt("2026-10-22T12:00:00Z");
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init?: RequestInit) => {
        init?.signal?.throwIfAborted();
        return opaqueRedirect();
      }),
    );
    const controller = new AbortController();
    controller.abort();

    await expect(getJson("/api/x", controller.signal)).rejects.toMatchObject({ name: "AbortError" });

    expect(reload).not.toHaveBeenCalled();
  });

  test("a_401_which_the_API_never_sends_to_the_web_app_is_an_error_like_any_other", async () => {
    pageAt("2026-10-22T12:00:00Z");

    for (const [method, call] of calls) {
      vi.stubGlobal("fetch", vi.fn(async () => respond(401, { title: "Unauthorized" })));

      const failure = await fail(call);

      expect(failure, method).toBeInstanceOf(ApiError);
      expect((failure as ApiError).status, method).toBe(401);
      expect(isRefusal(failure), method).toBe(true); // as every 4xx but a 408 and a 429 is, P4-R29: not a sign-out
    }
    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  });

  test("an_answer_that_is_a_success_or_an_error_does_not_touch_the_page", async () => {
    pageAt("2026-10-22T12:00:00Z");

    for (const status of [200, 204, 304, 404, 500, 503]) {
      vi.stubGlobal("fetch", vi.fn(async () => (status === 204 ? new Response(null, { status }) : respond(status))));
      for (const [, call] of calls) await fail(call);
    }

    expect(reload).not.toHaveBeenCalled();
    expect(window.sessionStorage.length).toBe(0);
  });
});
