import type { IncomingMessage, ServerResponse } from 'http';
import type { Db } from '../db/Db';
import { isAllowlisted, isAuthEnabled, isLoopbackHost, parseCookie, SESSION_COOKIE } from './authState';
import { isRentalExpired } from './rentalExpiry';
import { SessionStore } from './session';

// Login pages are served inline for unauthenticated navigations in locked mode. They reference
// NO gated bundle (the app shell); the only external file is /login-assets/globe.js, which the
// auth allowlist exposes on purpose and which carries no app code.
/*
 * 登录页：照 tianxi-ui 的 #/login 做双栏布局（左：标语 + cobe 地球 + 能力卡；右：登录卡）。
 * 未登录时拿不到 /tianxi.css 等静态文件，所以样式内联；地球脚本放在免登录的 /login-assets/。
 */
const AUTH_PAGE_STYLE = `<style>
:root{color-scheme:dark;--bg:#08090a;--surface:#0f1011;--surface-2:#16171a;--field:#0b0c0d;--line:rgb(255 255 255/.09);--line-strong:rgb(255 255 255/.15);--fg:#f7f8f8;--fg-2:#c8ccd2;--fg-3:#9097a0;--fg-4:#646a73;--accent:#5b9cff;--accent-2:#8b7cff;--ok:#3ecf8e;--err:#f2555a;--mono:"JetBrains Mono",ui-monospace,SFMono-Regular,Consolas,monospace}
*{box-sizing:border-box}
html,body{margin:0;min-height:100%}
body{min-height:100svh;overflow-x:clip;color:var(--fg);background:var(--bg);font:13px/1.5 "Inter Variable",Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.shell{min-height:100svh;display:grid;grid-template-columns:1.04fr .96fr}
.brand-side{position:relative;display:flex;flex-direction:column;min-height:100svh;overflow:hidden;border-right:1px solid var(--line)}
.top{position:relative;z-index:3;display:flex;align-items:center;justify-content:space-between;padding:24px 56px}
.logo{display:flex;align-items:center;gap:10px;font-size:15px;font-weight:600;letter-spacing:-.01em}
.mark{display:block;width:26px;height:26px}
.chip{padding:1px 6px;border:1px solid var(--line);border-radius:4px;color:var(--fg-3);font:500 10px/16px var(--mono);letter-spacing:.12em}
.status{display:flex;align-items:center;gap:6px;color:var(--fg-3);font-size:11px}
.dot{width:5px;height:5px;border-radius:50%;background:var(--ok);box-shadow:0 0 6px var(--ok)}
.label{display:flex;align-items:center;gap:8px;color:var(--fg-3);font:500 10px/1.25 var(--mono);letter-spacing:.12em;text-transform:uppercase}
.label i{width:4px;height:4px;border-radius:50%;background:var(--accent);box-shadow:0 0 4px var(--accent)}
.hero{position:relative;z-index:3;padding:16px 56px 0}
.hero h1{max-width:540px;margin:16px 0 0;font-size:40px;font-weight:500;line-height:1.08;letter-spacing:-.045em}
.grad{background:linear-gradient(90deg,var(--fg) 0%,#a9c8ff 45%,var(--accent-2) 100%);-webkit-background-clip:text;background-clip:text;color:transparent}
.hero p{max-width:400px;margin:10px 0 0;color:var(--fg-2);font-size:13px;line-height:24px}
.globe{position:absolute;left:50%;top:56%;width:560px;aspect-ratio:1;transform:translate(-50%,-50%);z-index:1}
.globe::before{content:"";position:absolute;left:50%;top:50%;width:121%;aspect-ratio:1;transform:translate(-50%,-50%);border-radius:50%;background:radial-gradient(circle closest-side,rgb(91 156 255/.25) 0%,rgb(91 156 255/.25) 72%,rgb(139 124 255/.13) 86%,rgb(139 124 255/0) 100%)}
.globe::after{content:"";position:absolute;left:50%;top:5%;width:88%;height:12%;transform:translate(-50%,-50%);border-radius:100%;background:radial-gradient(ellipse at center,rgb(150 190 255/.42),rgb(91 156 255/.24) 42%,rgb(139 124 255/.1) 66%,transparent 82%);mix-blend-mode:screen;pointer-events:none}
.globe canvas{position:relative;z-index:1;width:100%;height:100%;opacity:0;transition:opacity 1s cubic-bezier(.22,1,.36,1)}
.globe.no-webgl::before{background:radial-gradient(circle closest-side,#16171a 0%,#0f1011 70%,rgb(91 156 255/.25) 86%,transparent 100%)}
.feature{position:absolute;left:56px;bottom:16px;z-index:3;width:440px;padding:14px;border:1px solid var(--line);border-radius:12px;background:rgb(15 16 17/.9)}
.feature-head{display:flex;justify-content:space-between;color:var(--fg-3);font:500 9px/1.25 var(--mono);letter-spacing:.12em}
.feature-body{min-height:44px;margin-top:8px;color:var(--fg-2);font-size:12.5px;line-height:20px;transition:opacity .3s}
.feature-foot{display:flex;align-items:center;gap:6px;margin-top:10px}
.feature-foot b{width:16px;height:2px;border-radius:2px;background:var(--fg-4)}.feature-foot b.on{width:22px;background:var(--fg)}
.form-side{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:22px;padding:40px 24px}
.card{width:min(440px,100%);padding:32px 36px;border:1px solid var(--line);border-radius:16px;background:var(--surface);box-shadow:inset 0 1px 0 rgb(255 255 255/.04),0 24px 80px -20px rgb(0 0 0/.95)}
.card-head{display:flex;justify-content:space-between;align-items:center}
.card h2{margin:18px 0 4px;font-size:24px;font-weight:600;letter-spacing:-.03em;line-height:1.2}
.card .sub{margin:0 0 24px;color:var(--fg-3);line-height:1.6}
.card label{display:block;margin:14px 0 6px;color:var(--fg-2);font-size:12px;font-weight:500}
.field{position:relative}
input{display:block;width:100%;height:42px;padding:0 12px;border:1px solid var(--line);border-radius:8px;outline:none;color:var(--fg);background:var(--field);box-shadow:inset 0 1px 2px rgb(0 0 0/.35);font:14px/1.4 inherit;transition:border-color .15s,box-shadow .15s}
input::placeholder{color:var(--fg-4)}
input:focus{border-color:rgb(91 156 255/.6);box-shadow:0 0 0 3px rgb(91 156 255/.15)}
#code{font-family:var(--mono);letter-spacing:.1em}
.field input{padding-right:42px}
.eye{position:absolute;right:6px;top:50%;width:30px;height:30px;display:grid;place-items:center;padding:0;margin:0;transform:translateY(-50%);border:0;border-radius:6px;color:var(--fg-3);background:transparent;cursor:pointer}
.eye:hover{color:var(--fg);background:rgb(255 255 255/.05)}.eye svg{width:16px;height:16px}
.submit{width:100%;height:42px;margin-top:20px;display:flex;align-items:center;justify-content:center;gap:6px;border:0;border-radius:8px;color:var(--bg);background:var(--fg);box-shadow:inset 0 1px 0 rgb(255 255 255/.6),0 1px 2px rgb(0 0 0/.4);font:500 14px/1 inherit;cursor:pointer;transition:background-color .15s,transform .15s}
.submit:hover{background:rgb(247 248 248/.9)}.submit:active{transform:scale(.98)}.submit svg{width:15px;height:15px}
.submit:disabled{opacity:.6;pointer-events:none}
.err{min-height:20px;margin-top:8px;color:var(--err);font-size:12px}
.divider{height:1px;margin:22px 0 16px;background:var(--line)}
.hint{margin:0;color:var(--fg-3);font-size:12px;text-align:center}
.hint b{color:var(--fg-2);font-weight:500}
.foot{display:flex;flex-direction:column;align-items:center;gap:8px;color:var(--fg-4);font-size:11px}
.foot .mono{display:flex;align-items:center;gap:6px;font:500 10px/1 var(--mono);letter-spacing:.12em}
.foot svg{width:11px;height:11px}
.msg{margin:0;color:var(--fg-2);line-height:1.7}
@media(max-width:1023px){.shell{grid-template-columns:1fr}.brand-side{min-height:auto;border-right:0}.top{padding:14px 20px}.hero,.feature{display:none}.globe{position:relative;left:auto;top:auto;width:min(320px,92vw);margin:0 auto 8px;transform:none}.form-side{justify-content:flex-start;padding:8px 16px 32px}.card{padding:24px 20px}}
@media(max-width:639px){body{font-size:15px}input,.submit{height:46px;font-size:16px}.card h2{font-size:22px}}
@media(prefers-reduced-motion:reduce){*{transition-duration:.01ms!important}}
</style>`;

const ICON = (path: string) =>
    `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
const ARROW = ICON('<path d="M5 12h14M13 6l6 6-6 6"/>');
const LOCK = ICON('<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>');

/** 左栏：品牌、标语、地球、能力轮播（不放虚构的客户评价）。 */
const BRAND_SIDE = `<section class="brand-side">
<div class="top"><div class="logo"><img class="mark" src="/login-assets/tianxi-mark.svg" alt="" width="26" height="26">云手机<span class="chip">CONSOLE</span></div><div class="status"><span class="dot"></span>服务正常</div></div>
<div class="hero"><div class="label"><i></i>CLOUD PHONE · REMOTE CONTROL</div>
<h1>让每一台手机，<br><span class="grad">从一个控制台开始。</span></h1>
<p>浏览器里远程操控真机：低延迟投屏、批量同步、麦克风与声音，打开即用。</p></div>
<div class="globe"><canvas id="globe" aria-label="云手机节点地球"></canvas></div>
<div class="feature" aria-live="polite"><div class="feature-head"><span id="fn">PLATFORM / 01</span><span>01 / 03</span></div>
<div class="feature-body" id="fb">流畅视频与抽帧远控两种模式，网络差时自动切换，画面不断流。</div>
<div class="feature-foot"><b class="on"></b><b></b><b></b></div></div>
</section>`;

const FEATURE_SCRIPT = `<script>(()=>{const t=['流畅视频与抽帧远控两种模式，网络差时自动切换，画面不断流。','多台手机同屏平铺，一台主控、其余跟随，批量操作一次完成。','电脑麦克风直通手机，也能听手机正在播放的声音，不需要额外 App。'];
const b=document.getElementById('fb'),n=document.getElementById('fn'),d=[...document.querySelectorAll('.feature-foot b')];let i=0;
if(!b||matchMedia('(prefers-reduced-motion: reduce)').matches)return;
setInterval(()=>{i=(i+1)%t.length;b.style.opacity='0';setTimeout(()=>{b.textContent=t[i];n.textContent='PLATFORM / 0'+(i+1);n.nextElementSibling.textContent='0'+(i+1)+' / 03';d.forEach((x,k)=>x.classList.toggle('on',k===i));b.style.opacity='1';},200);},5600);})();</script>
<script src="/login-assets/globe.js?v=20261111" defer></script>`;

const FOOT = `<div class="foot"><span>识别码和账号由管理员分配，请勿转借他人</span><span class="mono">${LOCK}SESSION · HTTP-ONLY COOKIE</span></div>`;

function authPage(title: string, card: string, script = ''): string {
    return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><link rel="icon" type="image/svg+xml" href="/login-assets/tianxi-mark.svg"><link rel="icon" type="image/png" href="/login-assets/favicon.png">
${AUTH_PAGE_STYLE}
</head><body><main class="shell">${BRAND_SIDE}<section class="form-side">${card}${FOOT}</section></main>
${FEATURE_SCRIPT}${script}</body></html>`;
}

const LOGIN_PAGE_HTML = authPage(
    '进入云手机',
    `<form class="card" id="f"><div class="card-head"><span class="label">SIGN IN / 01</span><span class="status"><span class="dot"></span>服务正常</span></div>
<h2>进入云手机</h2><p class="sub">输入管理员分配给你的唯一识别码。</p>
<label for="code">识别码</label><input id="code" name="code" placeholder="例如 ab123456" autocomplete="one-time-code" autofocus>
<div class="err" id="e"></div><button class="submit" type="submit">立即连接${ARROW}</button>
<div class="divider"></div><p class="hint">还没有识别码？<b>联系管理员开通</b></p></form>`,
    `<script>
const f=document.getElementById('f'),e=document.getElementById('e');
const input=document.getElementById('code');
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';const code=input.value.trim();
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username:code,password:code})});
if(r.ok){location.href='/';}else{e.textContent='识别码无效、已停用或暂时锁定。';}}catch{e.textContent='网络连接失败，请重试。';}});
</script>`,
);

const EYE = ICON('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>');

const ADMIN_LOGIN_HTML = authPage(
    '管理员登录',
    `<form class="card" id="f"><div class="card-head"><span class="label">SIGN IN / ADMIN</span><span class="status"><span class="dot"></span>本机入口</span></div>
<h2>管理员登录</h2><p class="sub">这是本机管理入口。账号和密码分开填写，密码不会写在地址里。</p>
<label for="user">管理员账号</label><input id="user" name="username" autocomplete="username" placeholder="admin">
<label for="pass">管理员密码</label><div class="field"><input id="pass" name="password" type="password" autocomplete="current-password" placeholder="输入密码"><button class="eye" id="eye" type="button" aria-label="显示密码">${EYE}</button></div>
<div class="err" id="e"></div><button class="submit" type="submit">进入后台${ARROW}</button></form>`,
    `<script>
const f=document.getElementById('f'),e=document.getElementById('e');
const pass=document.getElementById('pass'),eye=document.getElementById('eye');
eye.addEventListener('click',()=>{const show=pass.type==='password';pass.type=show?'text':'password';eye.setAttribute('aria-label',show?'隐藏密码':'显示密码');});
f.addEventListener('submit',async (ev)=>{ev.preventDefault();e.textContent='';
const username=document.getElementById('user').value.trim();
const password=pass.value;
try{const r=await fetch('/api/auth/login',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({username,password})});
if(!r.ok){e.textContent='账号或密码不正确。';return;}
const me=await fetch('/api/auth/me');const data=await me.json();
if(data.user&&data.user.role==='admin'){location.href='/admin.html';return;}
await fetch('/api/auth/logout',{method:'POST'});
e.textContent='这个账号不是管理员。';}catch{e.textContent='网络连接失败，请重试。';}});
</script>`,
);

const ADMIN_LOCAL_ONLY_HTML = authPage(
    '管理入口在安装这台电脑上',
    `<div class="card"><div class="card-head"><span class="label">ADMIN / LOCAL ONLY</span></div>
<h2>管理入口在安装这台电脑上</h2>
<p class="msg">请在安装了手机远控的那台 Windows 上双击桌面的“管理后台”。公网地址只给租用识别码使用，这里没有管理员登录表单。</p></div>`,
);

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
