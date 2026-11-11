import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/Db';
import { isAllowlisted, isAuthEnabled, isLoopbackHost, parseCookie, SESSION_COOKIE } from './authState';
import { isRentalExpired } from './rentalExpiry';
import { SessionStore } from './session';

// Minimal, self-contained login page served inline for unauthenticated navigations in locked
// mode. It references NO external bundle/assets (the gated app shell), only an inline script that
// POSTs JSON to /api/auth/login and reloads on success — so it cannot leak the SPA shell and has
// no build dependency. Task 11 (client) may later replace this with a richer page.
/* Tianxi UI 暗色风格（未登录前拿不到 /tianxi.css，所以这里内联同一套令牌）。 */
const AUTH_PAGE_STYLE = `<style>:root{color-scheme:dark;--bg:#08090a;--surface:#0f1011;--field:#0b0c0d;--line:rgb(255 255 255/.09);--line-strong:rgb(255 255 255/.15);--fg:#f7f8f8;--fg-2:#c8ccd2;--fg-3:#9097a0;--fg-4:#646a73;--accent:#5b9cff;--accent-2:#8b7cff;--err:#f2555a;--ease:cubic-bezier(.22,1,.36,1)}*{box-sizing:border-box}body{position:relative;margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:20px;overflow-x:hidden;color:var(--fg);background:var(--bg);font:13px/1.5 "Inter Variable",Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}body::before{content:"";position:fixed;inset:0;pointer-events:none;background-image:radial-gradient(rgb(255 255 255/.055) 1px,transparent 1px);background-size:20px 20px;-webkit-mask-image:radial-gradient(ellipse 60% 50% at 50% 40%,#000,transparent 75%);mask-image:radial-gradient(ellipse 60% 50% at 50% 40%,#000,transparent 75%)}body::after{content:"";position:fixed;left:50%;top:18%;width:520px;height:320px;transform:translateX(-50%);pointer-events:none;background:radial-gradient(closest-side,rgb(91 156 255/.16),rgb(139 124 255/.06) 55%,transparent);filter:blur(10px)}form,main{position:relative;z-index:1;width:min(372px,100%);padding:28px;border:1px solid var(--line-strong);border-radius:16px;background:var(--surface);box-shadow:inset 0 1px 0 rgb(255 255 255/.04),0 24px 80px -20px rgb(0 0 0/.95)}main{width:min(460px,100%)}.mark{width:36px;height:36px;display:grid;place-items:center;margin-bottom:20px;border:1px solid transparent;border-radius:8px;background:linear-gradient(#16171a,#16171a) padding-box,linear-gradient(135deg,var(--accent),var(--accent-2)) border-box;box-shadow:0 0 16px -4px rgb(91 156 255/.6);font-weight:600}.eyebrow{display:block;margin-bottom:8px;color:var(--fg-4);font:500 10px/1.25 "JetBrains Mono",ui-monospace,monospace;letter-spacing:.12em;text-transform:uppercase}h1{margin:0 0 6px;font-size:22px;font-weight:600;letter-spacing:-.025em;line-height:1.2}.sub,p{margin:0 0 22px;color:var(--fg-3);line-height:1.6}label{display:block;margin:12px 0 6px;color:var(--fg-2);font-size:12px;font-weight:500}input{display:block;width:100%;height:40px;padding:0 12px;border:1px solid var(--line);border-radius:8px;outline:none;color:var(--fg);background:var(--field);box-shadow:inset 0 1px 2px rgb(0 0 0/.35);font:14px/1.4 inherit;transition:border-color .15s,box-shadow .15s}input::placeholder{color:var(--fg-4)}input:focus{border-color:rgb(91 156 255/.6);box-shadow:0 0 0 3px rgb(91 156 255/.15)}#code{font-family:"JetBrains Mono",ui-monospace,monospace;letter-spacing:.1em}button{width:100%;height:40px;margin-top:14px;border:0;border-radius:8px;color:var(--bg);background:var(--fg);box-shadow:inset 0 1px 0 rgb(255 255 255/.6),0 1px 2px rgb(0 0 0/.4);font:500 14px/1 inherit;cursor:pointer;transition:background-color .15s,transform .15s}button:hover{background:rgb(247 248 248/.9)}button:active{transform:scale(.98)}.err{min-height:20px;margin-top:8px;color:var(--err);font-size:12px}@media(max-width:639px){body{font-size:15px}form,main{padding:24px}input,button{height:44px;font-size:16px}}</style>`;

const LOGIN_PAGE_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>进入云手机</title>
${AUTH_PAGE_STYLE}
</head><body><form id="f"><div class="mark">控</div><span class="eyebrow">CLOUD PHONE</span><h1>进入云手机</h1><p class="sub">输入管理员分配给你的唯一识别码</p>
<input id="code" name="code" placeholder="云手机识别码" autocomplete="one-time-code" autofocus>
<div class="err" id="e"></div><button type="submit">立即连接</button></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e');
const input=document.getElementById('code');
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';const code=input.value.trim();
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:code,password:code})});
if(r.ok){location.href='/';}else{e.textContent='识别码无效、已停用或暂时锁定。';}}catch{e.textContent='网络连接失败，请重试。';}});
</script></body></html>`;

const ADMIN_LOGIN_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理员登录</title>
${AUTH_PAGE_STYLE}
</head><body><form id="f"><div class="mark">控</div><span class="eyebrow">ADMIN</span><h1>管理员登录</h1><p class="sub">这是本机管理入口。账号和密码分开填写，密码不会写在地址里。</p>
<label for="user">管理员账号</label><input id="user" name="username" autocomplete="username">
<label for="pass">管理员密码</label><input id="pass" name="password" type="password" autocomplete="current-password">
<div class="err" id="e"></div><button type="submit">进入后台</button></form>
<script>
const f=document.getElementById('f'),e=document.getElementById('e');
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';
const username=document.getElementById('user').value.trim();
const password=document.getElementById('pass').value;
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
if(!r.ok){e.textContent='账号或密码不正确。';return;}
const me=await fetch('/api/auth/me');const data=await me.json();
if(data.user&&data.user.role==='admin'){location.href='/admin.html';return;}
await fetch('/api/auth/logout',{method:'POST'});
e.textContent='这个账号不是管理员。';}catch{e.textContent='网络连接失败，请重试。';}});
</script></body></html>`;

const ADMIN_LOCAL_ONLY_HTML = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>管理入口在安装这台电脑上</title>
${AUTH_PAGE_STYLE}
</head><body><main><div class="mark">控</div><span class="eyebrow">ADMIN</span><h1>管理入口在安装这台电脑上</h1>
<p style="margin:0">请在安装了手机远控的那台 Windows 上双击桌面的“管理后台”。公网地址只给租用识别码使用，这里没有管理员登录表单。</p>
</main></body></html>`;

function serveHtml(res: ServerResponse, html: string): void {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(html);
}

function serveLoginPage(res: ServerResponse): void {
    serveHtml(res, LOGIN_PAGE_HTML);
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
            } else if (url.pathname === '/admin-login' && isLoopbackHost(req.headers.host)) {
                serveHtml(res, ADMIN_LOGIN_HTML);
            } else if (url.pathname === '/admin-login') {
                serveHtml(res, ADMIN_LOCAL_ONLY_HTML);
            } else {
                // Serve the tenant login page INLINE — never redirect to /login (that would fall
                // through to the static handler's index.html SPA fallback and leak the gated app shell).
                // /admin.html is not an admin login URL: it is the admin app, and it stays behind this gate.
                serveLoginPage(res);
            }
            return true; // handled → short-circuit the chain
        }
        (req as IncomingMessage & { user?: unknown }).user = user;
        return false; // authenticated → let the real handler run
    }
}
