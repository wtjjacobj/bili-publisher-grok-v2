import { join } from "path";

export function uiHelpersResponse(req: Request, url: URL, root: string, authorized: boolean): Response | null {
  if (url.pathname !== "/ui_helpers.js") return null;
  if (!authorized) return new Response("Unauthorized", { status: 401 });
  if (req.method !== "GET") return new Response("Not found", { status: 404 });
  return new Response(Bun.file(join(root, "public", "ui_helpers.js")), {
    headers: {
      "Content-Type": "application/javascript; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}
