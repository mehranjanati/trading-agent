// E00 skeleton — full control API lands in E05.
export default {
  async fetch(req: Request): Promise<Response> {
    const u = new URL(req.url);
    if (u.pathname === "/api/health") return Response.json({ ok: true, mode: "paper", e05: "pending" });
    return Response.json({ code: "NOT_IMPLEMENTED", message: "E05 pending", trace_id: "none", retryable: false }, { status: 501 });
  }
};
