/**
 * DocShell API 访问控制。
 *
 * 两种模式：
 *   - 设了 `DOCSHELL_TOKEN`（部署到服务器 / 绑网络时）→ **强制** token 校验：请求须带
 *     `x-docshell-token` 头且匹配。token 放自定义头天然防 CSRF（浏览器跨源发不了自定义头，
 *     除非服务端开 CORS 预检——我们不开）。
 *   - 没设 token（本机 dev，绑 127.0.0.1）→ 回退到 localhost 同源 Origin 校验（挡本机恶意网页）。
 *
 * 即：把服务绑到 0.0.0.0 暴露到网络时，务必同时设 DOCSHELL_TOKEN，否则就是无认证 RCE。
 * 生产启动脚本（scripts/start-prod.sh）会强制校验这一点。
 */
export function checkAuth(req: Request): Response | null {
  const token = process.env.DOCSHELL_TOKEN;

  if (token) {
    const provided = req.headers.get('x-docshell-token');
    if (provided !== token) {
      return new Response(JSON.stringify({ error: 'unauthorized' }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return null; // 通过
  }

  // 本机 dev：无 token，回退 localhost 同源校验
  const origin = req.headers.get('origin') || '';
  if (origin && !/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) {
    return new Response(JSON.stringify({ error: 'forbidden origin' }), {
      status: 403,
      headers: { 'Content-Type': 'application/json' },
    });
  }
  return null;
}
