import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/Db';
import { isAllowlisted, isAuthEnabled, parseCookie, SESSION_COOKIE } from './authState';
import { isRentalExpired } from './rentalExpiry';
import { SessionStore } from './session';

// Minimal, self-contained login page served inline for unauthenticated navigations in locked
// mode. It references NO external bundle/assets (the gated app shell), only an inline script that
// POSTs JSON to /api/auth/login and reloads on success — so it cannot leak the SPA shell and has
// no build dependency. Task 11 (client) may later replace this with a richer page.
const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进入云手机</title>
<style>*{box-sizing:border-box}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;background:radial-gradient(circle at 50% 0,#173762 0,#07111f 55%);color:#eef6ff;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0;padding:20px}form{background:#0e1c30e8;border:1px solid #29415f;padding:30px;border-radius:18px;width:min(360px,100%);box-shadow:0 24px 70px #0009}h1{font-size:24px;margin:0 0 7px}.sub{color:#8da3bd;margin:0 0 22px}input{display:block;width:100%;height:48px;padding:0 14px;background:#091526;border:1px solid #344c69;color:#fff;border-radius:10px;font-size:16px;letter-spacing:.08em;outline:none}input:focus{border-color:#4598ff;box-shadow:0 0 0 3px #4598ff25}button{width:100%;height:46px;margin-top:12px;background:#328af5;color:#fff;border:0;border-radius:10px;cursor:pointer;font-size:16px;font-weight:700}.err{color:#ff8d99;font-size:13px;min-height:20px;margin-top:9px}</style>
</head><body><form id="f"><h1>进入云手机</h1><p class="sub">输入管理员分配给你的唯一识别码</p>
<input id="code" name="code" placeholder="云手机识别码" autocomplete="one-time-code" autofocus>
<div class="err" id="e"></div><button type="submit">立即连接</button></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e');
const input=document.getElementById('code');
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';const code=input.value.trim();
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:code,password:code})});
if(r.ok){location.href='/';}else{e.textContent='识别码无效、已停用或暂时锁定。';}}catch{e.textContent='网络连接失败，请重试。';}});
</script></body></html>`;

function serveLoginPage(res: ServerResponse): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(LOGIN_PAGE_HTML);
}

export class AuthGate {
    constructor(private readonly getDb: () => Db) {}

    async handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
        const db = this.getDb();
        if (!isAuthEnabled(db)) return false; // open mode → not our concern

        const url = new URL(req.url ?? '/', 'http://localhost');
        if (isAllowlisted(url.pathname)) return false;

        const token = parseCookie(req.headers.cookie)[SESSION_COOKIE];
        const session = token ? new SessionStore(db.sqlite).findValid(token, Date.now()) : undefined;
        const user = session ? db.users.getById(session.userId) : undefined;
        // Fail CLOSED: no session, an orphan session (user deleted), or a disabled user → block.
        // (Never fall back to the implicit admin here — resolveUserId would otherwise grant admin.)
        const expired = user ? isRentalExpired(db, user.id, Date.now()) : false;
        if (expired && user) new SessionStore(db.sqlite).deleteForUser(user.id);
        if (!user || user.disabled || expired) {
            if (url.pathname.startsWith('/api/')) {
                res.writeHead(401, { 'content-type': 'application/json' });
                res.end(JSON.stringify({ error: 'unauthorized' }));
            } else {
                // Serve the login page INLINE — never redirect to /login (that would fall through
                // to the static handler's index.html SPA fallback and leak the gated app shell).
                serveLoginPage(res);
            }
            return true; // handled → short-circuit the chain
        }
        (req as IncomingMessage & { user?: unknown }).user = user;
        return false; // authenticated → let the real handler run
    }
}
