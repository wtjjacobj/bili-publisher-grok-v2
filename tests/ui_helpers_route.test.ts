import { describe, expect, test } from "bun:test";
import { uiHelpersResponse } from "../ui_helpers_route";

const ROOT = import.meta.dir + "/..";
const route = (request: Request, authorized: boolean) => uiHelpersResponse(request, new URL(request.url), ROOT, authorized);

describe("authenticated UI helper route", () => {
  test("rejects unauthenticated requests including query-string attempts", async () => {
    const direct = route(new Request("http://127.0.0.1/ui_helpers.js"), false);
    const query = route(new Request("http://127.0.0.1/ui_helpers.js?token=wrong"), false);

    expect(direct?.status).toBe(401);
    expect(query?.status).toBe(401);
  });

  test("serves only the exact authorized GET route with secure JavaScript headers", async () => {
    const response = route(new Request("http://127.0.0.1/ui_helpers.js?cache=1"), true);
    expect(response?.status).toBe(200);
    expect(response?.headers.get("Content-Type")).toContain("application/javascript");
    expect(response?.headers.get("Cache-Control")).toBe("no-store");
    expect(response?.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(await response?.text()).toContain("BiliUiHelpers");

    expect(route(new Request("http://127.0.0.1/ui_helpers.js/"), true)).toBeNull();
    expect(route(new Request("http://127.0.0.1/not-ui_helpers.js"), true)).toBeNull();
    expect(route(new Request("http://127.0.0.1/ui_helpers.js", { method: "POST" }), true)?.status).toBe(404);
  });
});
