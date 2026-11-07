// VideoLoader —— X(Twitter) / Telegram / 视频直链 下载器
// Cloudflare Workers 单文件版：UI + 解析 + 流式代理下载，全部在免费额度内运行。
//
// 路由：
//   GET /              手机端网页
//   GET /api/resolve?url=       解析链接 → { items: [{url,label,name,ext}] }
//   GET /download?u=&name=      流式代理下载（支持 Range 断点续传）
//   GET /img?u=                 缩略图代理（twimg/telesco.pe 图片同样需转发）
//   GET /healthz                健康检查
//
// 解析通道：
//   X(Twitter)  主：api.fxtwitter.com（开源项目 FixTweet，variants 自带全部清晰度）
//               备：api.vxtwitter.com
//   Telegram    公开频道帖子的网页嵌入页（?embed=1）内含无鉴权 telesco.pe/telegram-cdn 直链
//   直链        mp4/webm/mov/m4v 直接代理
//
// 安全：/download 只允许 twimg / telesco.pe / telegram-cdn 等媒体主机，不是开放代理。

// 统一用 iPhone Safari UA：部分源站（如 media.w3.org）会按 UA 拒绝桌面浏览器，移动 UA 兼容性最好
const UPSTREAM_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1';

const DL_HOST_OK = /(\.|^)(twimg\.com|telesco\.pe|telegram-cdn\.[a-z.]+|cdn-telegram\.org|cdn[0-9]*\.telegram\.org|telegram\.org|ts\.net)$/i;
const IMG_HOST_OK = /(\.|^)(twimg\.com|telesco\.pe|cdn-telegram\.org|cdn[0-9]*\.telegram\.org)$/i;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const secret = env?.VL_SECRET || 'videoloader-fallback-secret';
    try {
      switch (url.pathname) {
        case '/api/resolve':
          if (/youtube\.com|youtu\.be/i.test(url.hostname + ' ' + (url.searchParams.get('url') || ''))) {
            return await apiResolveYouTube(url, env, secret);
          }
          return await apiResolve(url, secret);
        case '/api/backup':
          return await apiBackup(request, url, env, secret);
        case '/api/pc/jobs':
          return await apiPcJobs(request, url, env, secret);
        case '/api/pc/update':
          return await apiPcUpdate(request, url, env, secret);
        case '/pc/agent.ps1':
          return pcAgentPs1();
        case '/pc/setup.bat':
          return pcSetupBat();
        case '/pc/sideloadly.dmg':
          // 临时：Mac 网络拉不动 Cloudflare 系响应体，借电脑代理中转 Sideloadly 安装包（用完删除）
          const up = await fetch('https://sideloadly.io/SideloadlySetup.dmg');
          return new Response(up.body, { headers: { 'content-type': 'application/octet-stream', 'content-disposition': 'attachment; filename="SideloadlySetup.dmg"' } });
        case '/download':
          return await apiDownload(request, url, secret);
        case '/stream':
          return await apiDownload(request, url, secret, true);
        case '/manifest': {
          var rawM = url.searchParams.get('items') || '';
          var itemsM;
          try {
            var b64m = rawM.split('-').join('+').split('_').join('/');
            while (b64m.length % 4) b64m += '=';
            var binM = atob(b64m);
            var bytesM = new Uint8Array(binM.length);
            for (var mi = 0; mi < binM.length; mi++) bytesM[mi] = binM.charCodeAt(mi);
            itemsM = JSON.parse(new TextDecoder().decode(bytesM));
          } catch (e) { return jres({ ok: false, error: '参数解析失败' }, 400); }
          if (!Array.isArray(itemsM) || !itemsM.length) return jres({ ok: false, error: '没有项目' }, 400);
          var BATCH = parseInt(url.searchParams.get('per') || '3', 10) || 3;
          var batches = [];
          for (var b0 = 0; b0 < itemsM.length; b0 += BATCH) {
            var slice = itemsM.slice(b0, b0 + BATCH);
            var b64part = btoa(String.fromCharCode.apply(null, new TextEncoder().encode(JSON.stringify(slice))));
            batches.push('tar?items=' + encodeURIComponent(b64part.split('+').join('-').split('_').join('/')));
          }
          return jres({ ok: true, total: itemsM.length, batches: batches });
        }
        case '/tar':
          return await apiTar(url, secret);
        case '/zip':
          return await apiZip(url, secret);
        case '/img':
          return await apiImg(url);
        case '/':
        case '/index.html':
          return new Response(page(), {
            headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' },
          });
        case '/healthz':
          return new Response('ok');
        case '/profile':
          return apiProfile(request);
        case '/manifest.webmanifest':
          return new Response(MANIFEST_JSON, {
            headers: { 'content-type': 'application/manifest+json; charset=utf-8', 'cache-control': 'public, max-age=86400' },
          });
        case '/apple-touch-icon.png':
          return pngResponse(ICON_180);
        case '/icon-192.png':
          return pngResponse(ICON_192);
        default:
          return new Response('not found', { status: 404 });
      }
    } catch (e) {
      return jres({ ok: false, error: e?.message || String(e) }, 502);
    }
  },
};

// ---------------- YouTube（Mac yt-dlp 引擎） ----------------
async function apiResolveYouTube(url, env, secret) {
  const target = url.searchParams.get("url") || "";
  if (!/youtube\.com|youtu\.be/i.test(target)) return jres({ ok: false, error: "不是 YouTube 链接" }, 400);
  if (!env || !env.VL_KV) return jres({ ok: false, error: "KV 未绑定" }, 501);
  const slot = await pcSlotOf(env, secret);
  const jobs = await pcRead(env, slot);
  const vid = (target.match(/(?:v=|youtu\.be\/|shorts\/)([A-Za-z0-9_-]{6,})/) || [])[1] || String(Date.now() % 100000);
  for (const j of jobs) if (j.u === target && (j.state === "pending" || j.state === "downloading")) {
    return jres({ ok: true, pcQueued: true, platform: "YouTube", title: "YouTube_" + vid, dupe: true });
  }
  const job = { id: "yt" + Date.now().toString(36), u: target, name: "YouTube_" + vid + ".mp4", dl: target, type: "yt", state: "pending", size: 0, error: "", at: Date.now() };
  jobs.push(job);
  await pcWrite(env, slot, jobs);
  return jres({ ok: true, pcQueued: true, platform: "YouTube", title: job.name });
}

// ---------------- 云端备份（单部署单槽位） ----------------
// 数据只在浏览器里有，服务端没法定时来取，所以是「网页有改动就自动推上来」而不是定时任务。
// 槽位键由 VL_SECRET 派生，不写成字面量，免得别人直接猜到备份地址。
async function apiBackup(request, url, env, secret) {
  if (!env || !env.VL_KV) return jres({ ok: false, error: '云端备份未配置（KV 未绑定）' }, 501);
  const slot = 'backup:' + (await hmacHex('cloud-backup-slot-v1', secret)).slice(0, 32);

  if (request.method === 'GET') {
    const vn = url.searchParams.get('v');
    const key = vn && /^[123]$/.test(vn) ? slot + ':v' + vn : slot;
    const raw = await env.VL_KV.get(key);
    if (!raw) return jres({ ok: true, empty: true });
    let d;
    try { d = JSON.parse(raw); } catch (e) { return jres({ ok: false, error: '云端备份已损坏' }, 500); }
    d.ok = true;                       // 前端靠这个字段判断有效性
    return new Response(JSON.stringify(d), {
      headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'access-control-allow-origin': '*' },
    });
  }

  if (request.method === 'POST' || request.method === 'PUT') {
    const text = await request.text();
    if (text.length > 2 * 1024 * 1024) return jres({ ok: false, error: '备份太大（超过 2MB）' }, 413);
    let d;
    try { d = JSON.parse(text); } catch (e) { return jres({ ok: false, error: '备份格式错误' }, 400); }
    if (!d || !Array.isArray(d.history)) return jres({ ok: false, error: '备份缺少 history' }, 400);
    if (!d.history.length) return jres({ ok: false, error: '历史为空，拒绝覆盖云端备份' }, 400);
    const payload = { v: 1, at: Date.now(), history: d.history.slice(0, 1000), pending: (d.pending || []).slice(0, 1000) };
    // 多版本轮转：保留最近 4 份（当前 + v1..v3）。单槽位曾被「新备份覆盖旧备份」坑过——旧版本是最后的救命稻草
    const v0 = await env.VL_KV.get(slot);
    const v1 = await env.VL_KV.get(slot + ':v1');
    const v2 = await env.VL_KV.get(slot + ':v2');
    if (v0) await env.VL_KV.put(slot + ':v1', v0);
    if (v1) await env.VL_KV.put(slot + ':v2', v1);
    if (v2) await env.VL_KV.put(slot + ':v3', v2);
    await env.VL_KV.put(slot, JSON.stringify(payload));
    return jres({ ok: true, at: payload.at, history: payload.history.length, pending: payload.pending.length });
  }

  return jres({ ok: false, error: 'method not allowed' }, 405);
}

// ---------------- 电脑下载队列（手机远程指挥 Windows 下载） ----------------
// 模式：Windows 上跑一个小代理（/pc/setup.bat 一键安装），每 5 秒来 Worker 领任务；
// 手机解析完点「到电脑」→ 任务进队列 → 电脑领走 → 直播下载（走 Worker 代理，电脑无需翻墙）→ 汇报完成。
// 任务存 KV 单槽位（电脑队列不需要多版本），state: pending / downloading / done / failed
async function pcSlotOf(env, secret) {
  void env;
  return 'pcjobs:' + (await hmacHex('pc-jobs-v1', secret)).slice(0, 32);
}
async function pcRead(env, slot) {
  if (!env || !env.VL_KV) return [];
  const raw = await env.VL_KV.get(slot);
  try { return JSON.parse(raw || '[]'); } catch (e) { return []; }
}
async function pcWrite(env, slot, jobs) {
  // 完成的任务最多留 40 条，防止无限膨胀
  const done = jobs.filter((j) => j.state === 'done' || j.state === 'failed');
  const active = jobs.filter((j) => j.state !== 'done' && j.state !== 'failed');
  await env.VL_KV.put(slot, JSON.stringify([...active, ...done.slice(-40)]));
}
async function apiPcJobs(request, url, env, secret) {
  if (!env || !env.VL_KV) return jres({ ok: false, error: 'KV 未绑定' }, 501);
  const slot = await pcSlotOf(env, secret);
  const jobs = await pcRead(env, slot);

  if (request.method === 'POST') {
    // 手机端创建任务：{ dl: '/download?u=..&s=..&name=..' }（签名在 dl 里，必须校验）
    let body;
    try { body = await request.json(); } catch (e) { return jres({ ok: false, error: '格式错误' }, 400); }
    const dl = String(body?.dl || '');
    let q;
    try { q = new URL(dl, url.origin).searchParams; } catch (e) { return jres({ ok: false, error: 'dl 解析失败' }, 400); }
    if (q.get('u') === null) return jres({ ok: false, error: 'dl 缺少 u 参数' }, 400);
    const u = q.get('u') || '';
    const sig = q.get('s') || '';
    const name = (q.get('name') || 'video.mp4').replace(/[\\/:*?"<>|\r\n]/g, '_').slice(0, 120);
    const sigOk = sig && /^[0-9a-f]{32}$/.test(sig) && (await hmacHex(u, secret)).slice(0, 32) === sig;
    if (!sigOk) return jres({ ok: false, error: '签名校验失败' }, 403);
    const job = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      u, name, dl,
      state: 'pending', size: 0, error: '',
      at: Date.now(),
    };
    // 同名同址的任务去重
    const dupe = jobs.find((j) => j.u === u && (j.state === 'pending' || j.state === 'downloading'));
    if (dupe) return jres({ ok: true, id: dupe.id, count: jobs.length, dupe: true });
    jobs.push(job);
    await pcWrite(env, slot, jobs);
    return jres({ ok: true, id: job.id, count: jobs.length });
  }

  // GET：电脑代理领任务（也供手机查队列状态）
  const want = url.searchParams.get('state');
  const list = want ? jobs.filter((j) => j.state === want) : jobs;
  return jres({ ok: true, jobs: list });
}
async function apiPcUpdate(request, url, env, secret) {
  if (!env || !env.VL_KV) return jres({ ok: false, error: 'KV 未绑定' }, 501);
  if (request.headers.get('x-vl-key') !== secret) return jres({ ok: false, error: 'key 不对' }, 403);
  const slot = await pcSlotOf(env, secret);
  const jobs = await pcRead(env, slot);
  let body;
  try { body = await request.json(); } catch (e) { return jres({ ok: false, error: '格式错误' }, 400); }
  const job = jobs.find((j) => j.id === body?.id);
  if (!job) return jres({ ok: false, error: '任务不存在' }, 404);
  if (body.state === 'downloading' || body.state === 'done' || body.state === 'failed') job.state = body.state;
  if (typeof body.size === 'number') job.size = body.size;
  if (typeof body.error === 'string') job.error = body.error.slice(0, 140);
  if (body.state === 'done') job.doneAt = Date.now();
  await pcWrite(env, slot, jobs);
  return jres({ ok: true });
}
// Windows 代理脚本（ASCII-only，避免 PowerShell 5.1 的编码坑）
function pcAgentPs1() {
  const L = [
    '# VideoLoader PC Agent - polls the worker for download jobs and saves to a fixed folder.',
    '# Edit $SaveDir below to change the destination folder, then restart the agent.',
    '$Base   = \'https://videoloader.7hvn4hvz8h.workers.dev\'',
    '$Key    = \'videoloader-fallback-secret\'',
    '$SaveDir = Join-Path $env:USERPROFILE \'Videos\\VideoLoader\'',
    'if (-not (Test-Path $SaveDir)) { New-Item -ItemType Directory -Path $SaveDir -Force | Out-Null }',
    'Write-Host ("[VideoLoader Agent] Saving to " + $SaveDir)',
    'function Report($id, $state, $size, $err) {',
    '  try {',
    '    Invoke-RestMethod -Uri ($Base + \'/api/pc/update\') -Method Post -ContentType \'application/json\' -Headers @{ \'X-VL-Key\' = $Key } -Body (@{ id = $id; state = $state; size = $size; error = $err } | ConvertTo-Json) | Out-Null',
    '  } catch { }',
    '}',
    'while ($true) {',
    '  try {',
    '    $r = Invoke-RestMethod -Uri ($Base + \'/api/pc/jobs\') -Method Get -TimeoutSec 20',
    '    foreach ($j in $r.jobs) {',
    '      if ($j.state -ne \'pending\') { continue }',
    '      Report $j.id \'downloading\' 0 \'\'',
    '      $dest = Join-Path $SaveDir $j.name',
    '      $i = 1',
    '      while (Test-Path $dest) { $dest = Join-Path $SaveDir ((Get-Item $dest).BaseName + \'(\' + $i + \')\' + (Get-Item $dest).Extension); $i++ }',
    '      try {',
    '        Invoke-WebRequest -Uri ($Base + $j.dl) -OutFile $dest -TimeoutSec 7200',
    '        $sz = (Get-Item $dest).Length',
    '        Report $j.id \'done\' $sz \'\'',
    '        Write-Host ("[OK] " + $j.name + " (" + $sz + " bytes)")',
    '      } catch {',
    '        $msg = $_.Exception.Message',
    '        if ($msg.Length -gt 120) { $msg = $msg.Substring(0, 120) }',
    '        Report $j.id \'failed\' 0 $msg',
    '        Write-Host ("[FAIL] " + $j.name + " : " + $msg)',
    '        if (Test-Path $dest) { Remove-Item $dest -Force -ErrorAction SilentlyContinue }',
    '      }',
    '    }',
    '  } catch { }',
    '  Start-Sleep -Seconds 5',
    '}',
  ];
  return new Response(L.join('\r\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}
function pcSetupBat() {
  const L = [
    '@echo off',
    'echo === VideoLoader PC Agent setup ===',
    'set AGENTDIR=%APPDATA%\\VideoLoader',
    'if not exist "%AGENTDIR%" mkdir "%AGENTDIR%"',
    'powershell -NoProfile -ExecutionPolicy Bypass -Command "Invoke-WebRequest -Uri \'https://videoloader.7hvn4hvz8h.workers.dev/pc/agent.ps1\' -OutFile \'%AGENTDIR%\\agent.ps1\'"',
    'if not exist "%AGENTDIR%\\agent.ps1" ( echo [ERROR] agent download failed & pause & exit /b 1 )',
    'schtasks /Create /SC ONLOGON /TN VideoLoaderAgent /TR "powershell.exe -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -File \'%AGENTDIR%\\agent.ps1\'" /F >nul',
    'schtasks /Run /TN VideoLoaderAgent >nul',
    'echo [OK] Agent installed and started. It runs at every logon.',
    'echo Videos will be saved to: %USERPROFILE%\\Videos\\VideoLoader',
    'echo (To change the folder, edit %AGENTDIR%\\agent.ps1 line starting with $SaveDir, then run: schtasks /Run /TN VideoLoaderAgent)',
    'echo You can close this window now.',
    'pause',
  ];
  return new Response(L.join('\r\n'), {
    headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' },
  });
}

// ---------------- 平台识别 ----------------
function detect(url) {
  let m;
  if ((m = url.match(/(?:twitter\.com|x\.com)\/([A-Za-z0-9_]{1,20})\/status(?:es)?\/(\d+)/)))
    return { platform: 'twitter', user: m[1], id: m[2] };
  if ((m = url.match(/(?:t\.me|telegram\.me)\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)/)))
    return { platform: 'telegram', channel: m[1], id: m[2] };
  if (/^https?:\/\/\S+\.(mp4|mov|m4v|webm)(\?\S*)?$/i.test(url)) return { platform: 'direct' };
  return null;
}

async function apiResolve(url, secret) {
  const target = (url.searchParams.get('url') || '').trim();
  const d = detect(target);
  if (!d)
    return jres(
      { ok: false, error: '无法识别链接，支持 X(Twitter) 推文、Telegram 公开频道帖子、mp4 直链' },
      400
    );
  let result;
  if (d.platform === 'twitter') result = await resolveTwitter(d, secret);
  else if (d.platform === 'telegram') result = await resolveTelegram(d, secret);
  else result = await resolveDirect(target, secret);
  return jres({ ok: true, ...result });
}

// ---------------- X (Twitter) ----------------
async function resolveTwitter({ id }, secret) {
  try {
    return await resolveTwitterFixTweet(id, secret);
  } catch (e1) {
    try {
      return await resolveTwitterVxTweet(id, secret);
    } catch (e2) {
      throw new Error(`X 解析失败：${e1.message} / 备用通道：${e2.message}`);
    }
  }
}

async function resolveTwitterFixTweet(id, secret) {
  const r = await fetch(`https://api.fxtwitter.com/status/${id}`, {
    headers: { 'user-agent': UPSTREAM_UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`FixTweet ${r.status}`);
  const j = await r.json();
  const t = j.tweet;
  if (!t) throw new Error(j.error?.message || '推文不存在');
  const vids = t.media?.videos || [];
  if (!vids.length) throw new Error('该推文没有视频');
  const items = [];
  for (const v of vids) {
    // variants: [{url, bitrate, content_type}]，同一分辨率取最高码率
    const byRes = new Map();
    for (const x of v.variants || []) {
      if (x.content_type !== 'video/mp4' || !x.url) continue;
      const m = x.url.match(/(\d{2,5})x(\d{2,5})/);
      const h = m ? +m[2] : 0;
      const key = m ? `${m[1]}x${m[2]}` : 'audio';
      const prev = byRes.get(key);
      if (!prev || (x.bitrate || 0) > (prev.bitrate || 0)) byRes.set(key, { ...x, h });
    }
    // 只取最高清晰度（用户无需再选画质）
    const best = [...byRes.values()]
      .filter((x) => x.h)
      .sort((a, b) => b.h - a.h || (b.bitrate || 0) - (a.bitrate || 0))[0];
    if (best) items.push({ url: best.url, ext: 'mp4', res: best.h });
  }
  if (!items.length) throw new Error('variants 里没有 mp4');
  return finalize({
    platform: 'X (Twitter)',
    author: t.author ? `${t.author.name} (@${t.author.screen_name})` : '',
    title: (t.text || '').slice(0, 100),
    thumb: t.media?.photos?.[0]?.url || vids[0]?.thumbnail_url || '',
    items,
    published: t.created_timestamp ? t.created_timestamp * 1000 : null,
    secret,
    nameBase: `X_${(t.text || 'video').replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 24) || 'video'}`,
  });
}

async function resolveTwitterVxTweet(id, secret) {
  const r = await fetch(`https://api.vxtwitter.com/status/${id}`, {
    headers: { 'user-agent': UPSTREAM_UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!r.ok) throw new Error(`VxTweet ${r.status}`);
  const j = await r.json();
  const media = (j.media_extended || j.mediaURLs || []).filter((m) => (m.type || '').includes('mp4') || /\.mp4(\?|$)/.test(m.url || ''));
  if (!media.length) throw new Error('该推文没有视频');
  const items = media.map((m) => ({ url: m.url, ext: 'mp4', res: m.size ? +String(m.size).split('x')[1] || 0 : 0 }));
  return finalize({
    platform: 'X (Twitter)',
    author: j.user_name ? `${j.user_name} (@${j.user_screen_name})` : '',
    title: (j.text || '').slice(0, 100),
    thumb: j.mediaURLs?.find((u) => typeof u === 'string') || '',
    items,
    secret,
    nameBase: `X_${(j.text || 'video').replace(/[^\w\u4e00-\u9fa5-]+/g, '').slice(0, 24) || 'video'}`,
  });
}

// ---------------- Telegram ----------------
async function resolveTelegram({ channel, id }, secret) {
  const bases = [
    `https://t.me/${channel}/${id}?embed=1&mode=tme&single=1`,
    `https://t.me/${channel}/${id}?embed=1&mode=tme`,
    `https://t.me/${channel}/${id}?embed=1`,
    `https://t.me/s/${channel}?before=${Number(id) + 1}`,
    `https://t.me/s/${channel}`,
  ];
  const errors = [];
  for (const b of bases) {
    try {
      const r = await fetch(b, {
        headers: { 'user-agent': UPSTREAM_UA, referer: 'https://t.me/' },
        signal: AbortSignal.timeout(9000),
      });
      if (!r.ok) { errors.push(`${short(b)}→HTTP ${r.status}`); continue; }
      const html = await r.text();
      const urls = extractTelegramVideos(html);
      if (urls.length)
        return finalize({
          platform: 'Telegram',
          author: '@' + channel,
          title: ogTitle(html) || `${channel} · 帖子 ${id}`,
          thumb: '',
          items: urls.map((u) => ({ url: u, ext: 'mp4' })),
          secret,
          nameBase: `TG_${channel}_${id}`,
        });
      errors.push(`${short(b)}→无视频直链(${html.length}B)`);
    } catch (e) {
      errors.push(`${short(b)}→${e.message}`);
    }
  }
  throw new Error(`Telegram 提取失败（确认是公开频道且帖子含视频）：${errors.join(' | ')}`);
}
const short = (u) => u.replace('https://t.me', '');

function extractTelegramVideos(html) {
  const out = new Set();
  const add = (u) => {
    if (!u) return;
    u = u.replace(/\\\//g, '/').replace(/&amp;/g, '&');
    if (/^https?:\/\//.test(u)) out.add(u);
  };
  let m;
  for (const re of [
    /<video[^>\s]*[^>]*\ssrc="([^"]+)"/gi,
    /<source[^>]*\ssrc="([^"]+\.mp4[^"]*)"/gi,
    /data-video-src="([^"]+)"/gi,
    /property="og:video(?::url|:secure_url)?"[^>]*content="([^"]+)"/gi,
    /content="([^"]+)"[^>]*property="og:video(?::url|:secure_url)?"/gi,
    /"(?:video_url|videoUrl|video_src)":"(https:[^"]+?\.(?:mp4)[^"]*?)"/gi,
    // 兜底：直接扫任何 Telegram CDN 上的 mp4（覆盖新旧域名）
    /(https:\/\/[a-z0-9.-]*(?:telesco\.pe|telegram-cdn\.[a-z.]+|cdn-telegram\.org|cdn[0-9]*\.telegram\.org)\/[^"'\s<>]+\.mp4[^"'\s<>]*)/gi,
  ])
    while ((m = re.exec(html))) add(m[1]);
  return [...out];
}
const ogTitle = (h) => (h.match(/<meta[^>]+property="og:title"[^>]+content="([^"]*)"/) || [])[1] || '';

// ---------------- 视频直链 ----------------
async function resolveDirect(target, secret) {
  let size = '';
  try {
    const h = await fetch(target, { method: 'HEAD', signal: AbortSignal.timeout(6000) });
    const n = +h.headers.get('content-length');
    if (n) size = ` · ${(n / 1048576).toFixed(1)}MB`;
  } catch {}
  const file = decodeURIComponent(new URL(target).pathname.split('/').pop()) || 'video';
  const ext = (file.match(/\.(mp4|webm|mov|m4v)$/i) || ['mp4'])[0].replace('.', '');
  return finalize({
    platform: '直链',
    author: new URL(target).hostname,
    title: file,
    thumb: '',
    items: [{ url: target, ext }],
    secret,
    nameBase: file.replace(new RegExp(`\\.${ext}$`, 'i'), ''),
    sizeSuffix: size,
  });
}

// ---------------- 公共收尾：补文件大小、生成文件名 ----------------
async function finalize({ platform, author, title, thumb, items, nameBase, sizeSuffix = '', secret, published }) {
  const sized = await Promise.all(
    items.slice(0, 6).map(async (it) => {
      let bytes = 0;
      let sizeLabel = '';
      try {
        const h = await fetch(it.url, {
          method: 'HEAD',
          headers: { 'user-agent': UPSTREAM_UA, referer: refFor(it.url) },
          signal: AbortSignal.timeout(5000),
        });
        const n = +h.headers.get('content-length');
        if (n) {
          bytes = n;
          sizeLabel = `${(n / 1048576).toFixed(1)}MB`;
        }
      } catch {}
      const q = it.res ? `${it.res}p` : it.ext.toUpperCase();
      // bytes 会一路传到客户端，用来算真实下载百分比
      // （Cloudflare 对流式响应会丢掉 content-length，不能只靠响应头）
      return { ...it, bytes, label: `${q}${sizeLabel ? ` · ${sizeLabel}` : sizeSuffix}` };
    })
  );
  sized.sort((a, b) => (b.res || 0) - (a.res || 0));
  for (const it of sized) {
    it.name = `${nameBase || 'video'}${it.res ? `_${it.res}p` : ''}.${it.ext || 'mp4'}`;
    it.sig = (await hmacHex(it.url, secret)).slice(0, 32);
  }
  return { platform, author, title, thumb, published: published || null, items: sized };
}

const refFor = (u) =>
  /twimg/.test(u) ? 'https://x.com/' : /telesco|telegram/.test(u) ? 'https://t.me/' : new URL(u).origin;

// ---------------- 下载代理（支持 Range） ----------------
async function apiDownload(request, url, secret, inline = false) {
  const target = url.searchParams.get('u') || '';
  const sig = url.searchParams.get('s') || '';
  const name =
    (url.searchParams.get('name') || 'video.mp4').replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\.{2,}/g, '.').slice(0, 120) ||
    'video.mp4';
  let host = '';
  try { host = new URL(target).hostname; } catch {}
  const hostOk = /^https:/.test(target) && DL_HOST_OK.test(host);
  const sigOk = sig && /^[0-9a-f]{32}$/.test(sig) && (await hmacHex(target, secret)).slice(0, 32) === sig;
  if (!hostOk && !sigOk)
    return jres({ ok: false, error: '该地址不在允许下载的范围（请先通过解析获取直链）' }, 403);

  const headers = { 'user-agent': UPSTREAM_UA, referer: refFor(target) };
  const range = request.headers.get('range');
  if (range) headers.range = range;
  const upstream = await fetch(target, { headers, redirect: 'follow' });
  if (!upstream.ok && upstream.status !== 206)
    throw new Error(`取回视频失败：HTTP ${upstream.status}`);

  const out = new Headers();
  out.set('content-type', upstream.headers.get('content-type') || 'application/octet-stream');
  for (const k of ['content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
    const v = upstream.headers.get(k);
    if (v) out.set(k, v);
  }
  // 自定义头不会被流式响应的 chunked 编码顶掉，客户端用它兜底算进度
  const cl = upstream.headers.get('content-length');
  if (cl) out.set('x-vl-size', cl);
  const cr = upstream.headers.get('content-range');
  if (cr) out.set('x-vl-range', cr);
  out.set('access-control-expose-headers', 'content-length, content-range, accept-ranges, x-vl-size, x-vl-range');
  const disp = `filename="video.mp4"; filename*=UTF-8''${encodeURIComponent(name)}`;
  out.set('content-disposition', `${inline ? 'inline' : 'attachment'}; ${disp}`);
  out.set('cache-control', 'no-store');
  if (!out.has('accept-ranges')) out.set('accept-ranges', 'bytes');
  return new Response(upstream.body, { status: upstream.status, headers: out });
}

// ---------------- 批量打包（流式 ZIP，避免 Safari 串行下载互相冲突） ----------------
var CRC_TABLE = (function () {
  var t = new Uint32Array(256);
  for (var n = 0; n < 256; n++) {
    var c = n;
    for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  var crc = 0xffffffff;
  for (var i = 0; i < bytes.length; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosDateTime(d) {
  var time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() / 2)) & 0xffff;
  var date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time: time, date: date };
}

function zipName(name, idx) {
  var clean = (name || ('video' + (idx + 1) + '.mp4')).replace(/[\\/:*?"<>|\r\n]/g, '_').replace(/\.{2,}/g, '.').slice(0, 100);
  if (!/\.(mp4|mov|m4v|webm|jpg|jpeg|png)$/i.test(clean)) clean += '.mp4';
  return clean;
}

// ---------------- 批量打包：TAR（无 CRC，一遍流式 → 不受 CPU/内存限制） ----------------
function tarHeader(name, size, mtime) {
  var h = new Uint8Array(512);
  var enc = new TextEncoder();
  var put = function (off, str, len) {
    var b = enc.encode(str);
    h.set(b.subarray(0, len), off);
  };
  put(0, name, 100);
  put(100, '0000644' + String.fromCharCode(0), 8);
  put(108, '0000000' + String.fromCharCode(0), 8);
  put(116, '0000000' + String.fromCharCode(0), 8);
  put(124, size.toString(8).padStart(11, '0') + String.fromCharCode(0), 12);
  put(136, Math.floor(mtime / 1000).toString(8).padStart(11, '0') + String.fromCharCode(0), 12);
  for (var i = 148; i < 156; i++) h[i] = 0x20;      // 校验和字段先填空格
  put(156, '0', 1);                                  // 普通文件
  put(257, 'ustar' + String.fromCharCode(0), 6);
  put(263, '00', 2);
  var sum = 0;
  for (var k = 0; k < 512; k++) sum += h[k];
  put(148, sum.toString(8).padStart(6, '0') + String.fromCharCode(0) + ' ', 8);
  return h;
}

async function apiTar(url, secret) {
  var raw = url.searchParams.get('items') || '';
  var items;
  try {
    var b64 = raw.split('-').join('+').split('_').join('/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
    items = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return jres({ ok: false, error: '参数解析失败' }, 400);
  }
  if (!Array.isArray(items) || !items.length) return jres({ ok: false, error: '没有可打包的项目' }, 400);
  if (items.length > 50) return jres({ ok: false, error: '一次最多打包 50 个文件' }, 400);

  // 分包支持：?from=0&to=2 只打包 [from, to) 区间的文件（大文件场景由快捷指令分批调用）
  var from = Math.max(0, parseInt(url.searchParams.get('from') || '0', 10) || 0);
  var to = Math.min(items.length, parseInt(url.searchParams.get('to') || String(items.length), 10) || items.length);
  if (from >= to) return jres({ ok: false, error: '范围无效' }, 400);
  items = items.slice(from, to);

  for (var v = 0; v < items.length; v++) {
    var t = items[v] && items[v].u;
    var host = '';
    try { host = new URL(t).hostname; } catch (e) { return jres({ ok: false, error: '第 ' + (v + 1) + ' 项地址无效' }, 400); }
    var hostOk = /^https:/.test(t) && DL_HOST_OK.test(host);
    var sigOk = items[v].s && /^[0-9a-f]{32}$/.test(items[v].s) && (await hmacHex(t, secret)).slice(0, 32) === items[v].s;
    if (!hostOk && !sigOk) return jres({ ok: false, error: '第 ' + (v + 1) + ' 项不在允许范围' }, 403);
  }

  // 只需要知道每个文件的大小（HEAD，很轻），不用读内容、不用算 CRC
  var sizes = [];
  for (var s = 0; s < items.length; s++) {
    var sz = await headSize(items[s].u);
    if (!sz) return jres({ ok: false, error: '第 ' + (s + 1) + ' 个文件读取失败，请重试' }, 502);
    sizes.push(sz);
  }

  var enc2 = new TextEncoder();
  var mtime = Date.now();
  var stream = new ReadableStream({
    async start(controller) {
      try {
        for (var i = 0; i < items.length; i++) {
          var nm = zipName(items[i].name, i);
          var size = sizes[i];
          controller.enqueue(tarHeader(nm, size, mtime));

          var up = await fetch(items[i].u, { headers: { 'user-agent': UPSTREAM_UA, referer: refFor(items[i].u) } });
          if (!up.ok || !up.body) throw new Error('第 ' + (i + 1) + ' 个文件读取失败（HTTP ' + up.status + '）');
          var reader = up.body.getReader();
          var written = 0;
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            written += chunk.value.length;
            controller.enqueue(chunk.value);
          }
          // 数据补零到 512 的倍数
          var pad = (512 - (written % 512)) % 512;
          if (pad) controller.enqueue(new Uint8Array(pad));
        }
        controller.enqueue(new Uint8Array(1024));   // TAR 结尾两个零块
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });

  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  var name = 'videoloader-' + stamp + '.tar';
  return new Response(stream, {
    headers: {
      'content-type': 'application/x-tar',
            'content-disposition': `inline; filename="videoloader.tar"; filename*=UTF-8''videoloader-${stamp}.tar`,
      'cache-control': 'no-store',
    },
  });
}

function extOf(name) {
  var m = String(name || '').match(/\.(mp4|mov|m4v|webm|jpg|jpeg|png)$/i);
  return m ? m[0].toLowerCase() : '.mp4';
}

// 只拿大小（HEAD），失败重试
async function headSize(target) {
  for (var attempt = 0; attempt < 2; attempt++) {
    try {
      var r = await fetch(target, { method: 'HEAD', headers: { 'user-agent': UPSTREAM_UA, referer: refFor(target) } });
      var n = +(r.headers.get('content-length') || 0);
      if (r.ok && n > 0) return n;
    } catch (e) {}
  }
  return 0;
}

async function apiZip(url, secret) {
  var raw = url.searchParams.get('items') || '';
  var items;
  try {
    // 支持 base64url（- _ 代替 + /，可省 padding）与标准 base64
    var b64 = raw.split('-').join('+').split('_').join('/');
    while (b64.length % 4) b64 += '=';
    var bin = atob(b64);
    var bytes = new Uint8Array(bin.length);
    for (var bi = 0; bi < bin.length; bi++) bytes[bi] = bin.charCodeAt(bi);
    items = JSON.parse(new TextDecoder().decode(bytes));
  } catch (e) {
    return jres({ ok: false, error: '参数解析失败' }, 400);
  }
  if (!Array.isArray(items) || !items.length) return jres({ ok: false, error: '没有可打包的项目' }, 400);
  if (items.length > 30) return jres({ ok: false, error: '一次最多打包 30 个文件' }, 400);

  for (var i = 0; i < items.length; i++) {
    var t = items[i] && items[i].u;
    var host = '';
    try { host = new URL(t).hostname; } catch (e) { return jres({ ok: false, error: '第 ' + (i + 1) + ' 项地址无效' }, 400); }
    var hostOk = /^https:/.test(t) && DL_HOST_OK.test(host);
    var sigOk = items[i].s && /^[0-9a-f]{32}$/.test(items[i].s) && (await hmacHex(t, secret)).slice(0, 32) === items[i].s;
    if (!hostOk && !sigOk) return jres({ ok: false, error: '第 ' + (i + 1) + ' 项不在允许范围' }, 403);
  }

  // 两遍法：第一遍流式算 CRC/大小（内存恒定，多大的文件都不爆），
  // 第二遍流式输出「标准 ZIP」——没有 data descriptor，iOS 才认。
  var meta = [];
  for (var m = 0; m < items.length; m++) {
    var info = await scanFile(items[m].u);
    if (!info) return jres({ ok: false, error: '第 ' + (m + 1) + ' 个文件读取失败，请重试' }, 502);
    meta.push(info);
  }

  var enc = new TextEncoder();
  var now = dosDateTime(new Date());
  var stream = new ReadableStream({
    async start(controller) {
      try {
        var offset = 0, central = [];
        for (var k = 0; k < items.length; k++) {
          var nm = enc.encode(zipName(items[k].name, k));
          var info = meta[k];
          var lh = new DataView(new ArrayBuffer(30));
          lh.setUint32(0, 0x04034b50, true);
          lh.setUint16(4, 20, true);
          lh.setUint16(6, 0x0800, true);              // 仅 UTF-8 标志，不设 data descriptor
          lh.setUint16(8, 0, true);
          lh.setUint16(10, now.time, true);
          lh.setUint16(12, now.date, true);
          lh.setUint32(14, info.crc, true);
          lh.setUint32(18, info.size, true);
          lh.setUint32(22, info.size, true);
          lh.setUint16(26, nm.length, true);
          lh.setUint16(28, 0, true);
          controller.enqueue(new Uint8Array(lh.buffer));
          controller.enqueue(nm);
          offset += 30 + nm.length;

          var up = await fetch(items[k].u, { headers: { 'user-agent': UPSTREAM_UA, referer: refFor(items[k].u) } });
          if (!up.ok || !up.body) throw new Error('第 ' + (k + 1) + ' 个文件读取失败（HTTP ' + up.status + '）');
          var reader = up.body.getReader();
          for (;;) {
            var chunk = await reader.read();
            if (chunk.done) break;
            offset += chunk.value.length;
            controller.enqueue(chunk.value);
          }

          var ch = new DataView(new ArrayBuffer(46));
          ch.setUint32(0, 0x02014b50, true);
          ch.setUint16(4, 20, true);
          ch.setUint16(6, 20, true);
          ch.setUint16(8, 0x0800, true);
          ch.setUint16(10, 0, true);
          ch.setUint16(12, now.time, true);
          ch.setUint16(14, now.date, true);
          ch.setUint32(16, info.crc, true);
          ch.setUint32(20, info.size, true);
          ch.setUint32(24, info.size, true);
          ch.setUint16(28, nm.length, true);
          ch.setUint16(30, 0, true);
          ch.setUint16(32, 0, true);
          ch.setUint16(34, 0, true);
          ch.setUint16(36, 0, true);
          ch.setUint32(38, 0, true);
          ch.setUint32(42, offset - info.size - 30 - nm.length, true);
          central.push(new Uint8Array(ch.buffer), nm);
        }
        var cdSize = 0;
        for (var c = 0; c < central.length; c++) cdSize += central[c].length;
        for (var ci = 0; ci < central.length; ci++) controller.enqueue(central[ci]);
        var eocd = new DataView(new ArrayBuffer(22));
        eocd.setUint32(0, 0x06054b50, true);
        eocd.setUint16(4, 0, true);
        eocd.setUint16(6, 0, true);
        eocd.setUint16(8, items.length, true);
        eocd.setUint16(10, items.length, true);
        eocd.setUint32(12, cdSize, true);
        eocd.setUint32(16, offset, true);
        eocd.setUint16(20, 0, true);
        controller.enqueue(new Uint8Array(eocd.buffer));
        controller.close();
      } catch (err) {
        controller.error(err);
      }
    }
  });

  var stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
  return new Response(stream, {
    headers: {
      'content-type': 'application/zip',
            'content-disposition': `inline; filename="videoloader.zip"; filename*=UTF-8''videoloader-${stamp}.zip`,
      'cache-control': 'no-store',
    },
  });
}

// 流式扫一遍文件，只算出 CRC 和大小（不保留数据，内存恒定）
async function scanFile(target) {
  for (var attempt = 0; attempt < 3; attempt++) {
    try {
      var up = await fetch(target, { headers: { 'user-agent': UPSTREAM_UA, referer: refFor(target) } });
      if (!up.ok || !up.body) { if (attempt === 2) return null; continue; }
      var reader = up.body.getReader();
      var crc = 0xffffffff, size = 0;
      for (;;) {
        var chunk = await reader.read();
        if (chunk.done) break;
        var v = chunk.value;
        for (var b = 0; b < v.length; b++) crc = CRC_TABLE[(crc ^ v[b]) & 0xff] ^ (crc >>> 8);
        size += v.length;
      }
      return { crc: (crc ^ 0xffffffff) >>> 0, size: size };
    } catch (e) {
      if (attempt === 2) return null;
      await new Promise(function (r) { setTimeout(r, 700); });
    }
  }
  return null;
}

// ---------------- 缩略图代理 ----------------
async function apiImg(url) {
  const target = url.searchParams.get('u') || '';
  let host = '';
  try { host = new URL(target).hostname; } catch {}
  if (!IMG_HOST_OK.test(host)) return jres({ ok: false, error: 'host not allowed' }, 403);
  const r = await fetch(target, {
    headers: { 'user-agent': UPSTREAM_UA, referer: 'https://x.com/' },
    signal: AbortSignal.timeout(8000),
  });
  if (!r.ok || !r.body) throw new Error(`图片取回失败 HTTP ${r.status}`);
  return new Response(r.body, {
    headers: { 'content-type': r.headers.get('content-type') || 'image/jpeg', 'cache-control': 'public, max-age=600' },
  });
}

// ---------------- 工具 ----------------
function jres(obj, code = 200) {  return new Response(JSON.stringify(obj), {
    status: code,
    headers: { 'content-type': 'application/json; charset=utf-8', 'access-control-allow-origin': '*' },
  });
}

// ---------------- 签名（防开放代理：/download 只放行白名单主机或带签名的直链） ----------------
async function hmacHex(msg, secret) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------------- iOS 描述文件（Web Clip，免上架的另一种安装方式） ----------------
async function apiProfile(request) {
  const origin = new URL(request.url).origin;
  const uuid = () => crypto.randomUUID().toUpperCase();
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>PayloadContent</key>
  <array>
    <dict>
      <key>FullScreen</key><true/>
      <key>Icon</key><data>${ICON_192}</data>
      <key>IsRemovable</key><true/>
      <key>Label</key><string>VideoLoader</string>
      <key>PayloadIdentifier</key><string>com.videoloader.webclip</string>
      <key>PayloadType</key><string>com.apple.webClip.managed</string>
      <key>PayloadUUID</key><string>${uuid()}</string>
      <key>PayloadVersion</key><integer>1</integer>
      <key>URL</key><string>${origin}</string>
    </dict>
  </array>
  <key>PayloadDisplayName</key><string>VideoLoader</string>
  <key>PayloadDescription</key><string>视频下载器（Web Clip，可随时在设置里删除）</string>
  <key>PayloadIdentifier</key><string>com.videoloader.profile</string>
  <key>PayloadOrganization</key><string>VideoLoader</string>
  <key>PayloadRemovalDisallowed</key><false/>
  <key>PayloadType</key><string>Configuration</string>
  <key>PayloadUUID</key><string>${uuid()}</string>
  <key>PayloadVersion</key><integer>1</integer>
</dict>
</plist>`;
  return new Response(xml, {
    headers: {
      'content-type': 'application/x-apple-aspen-config; charset=utf-8',
      'content-disposition': 'attachment; filename="videoloader.mobileconfig"',
      'cache-control': 'no-store',
    },
  });
}

// ---------------- PWA：manifest 与图标（base64 内嵌，保持单文件） ----------------
function base64ToBytes(b64) {
  const bin = atob(b64);
  const u = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i);
  return u;
}
const pngResponse = (b64) =>
  new Response(base64ToBytes(b64), { headers: { 'content-type': 'image/png', 'cache-control': 'public, max-age=86400' } });
const ICON_180 = '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';
const ICON_192 = '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';
const MANIFEST_JSON = JSON.stringify({
  name: 'VideoLoader',
  short_name: 'VideoLoader',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  background_color: '#0b1020',
  theme_color: '#0b1020',
  icons: [
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'maskable' },
  ],
});


// ---------------- 前端页面 ----------------
function page() {
  var js = [
"const $ = function (s) { return document.querySelector(s); };",
"function status(t, err) { var el = $('#status'); el.textContent = t || ''; el.className = 'status' + (err ? ' err' : ''); }",
"function esc(s) { return (s || '').replace(/[&<>\"]/g, function (c) { return ({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'})[c]; }); }",
"var SC_ONE = '保存视频到相册';",
"var SC_ZIP = '批量存相册';",
"var PKEY = 'vl_pending';",
"var MODE_KEY = 'vl_mode';",
"var HKEY = 'vl_history';",
"function getMode() { return localStorage.getItem(MODE_KEY) || 'batch'; }",
"function setMode(m) { localStorage.setItem(MODE_KEY, m); applyMode(); renderPending(); }",
"function applyMode() {",
"  var m = getMode();",
"  var btns = document.querySelectorAll('.mode-btn');",
"  for (var i = 0; i < btns.length; i++) btns[i].classList.toggle('on', btns[i].getAttribute('data-m') === m);",
"  var ta = document.getElementById('url');",
"  if (ta) ta.placeholder = m === 'batch' ? '粘贴链接即自动解析（可连续粘贴多条）' : '粘贴一条链接，解析后点「存到相册」';",
"}",
"function nativeBridge() { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.saveVideo); }",
"function androidBridge() { return !!(window.AndroidBridge && window.AndroidBridge.saveVideo); }",
"function batchBridge() { return !!(window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.saveVideoBatch); }",
"function dlFullUrl(x) { return location.origin + dlHref(x.u, x.name, x.s); }",
"function nativePayload(list) {",
"  return list.map(function (x) { return { url: dlFullUrl(x), name: x.name, size: x.size || 0 }; });",
"}",
"function isIOS() { return /iPhone|iPad|iPod/.test(navigator.userAgent || '') || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1); }",
"function dlHref(u, name, sig) { return '/download?u=' + encodeURIComponent(u) + '&name=' + encodeURIComponent(name) + '&s=' + (sig || ''); }",
"function NL() { return String.fromCharCode(10); }",
"function b64u(list) {",
"  var bytes = new TextEncoder().encode(JSON.stringify(list.map(function (x) { return { u: x.u, s: x.s, name: x.name }; })));",
"  var bin = '';",
"  for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);",
"  return btoa(bin).split('+').join('-').split('/').join('_').split('=').join('');",
"}",
"function splitLinks(text) {",
"  var norm = String(text || '').split(String.fromCharCode(13)).join('');",
"  var parts = norm.split(String.fromCharCode(10));",
"  var seen = {}, out = [];",
"  for (var i = 0; i < parts.length; i++) {",
"    var s = parts[i].trim();",
"    if (s && !seen[s]) { seen[s] = 1; out.push(s); }",
"  }",
"  return out;",
"}",
"async function resolveOne(line) {",
"  var r = await fetch('/api/resolve?url=' + encodeURIComponent(line));",
"  var j = await r.json();",
"  if (!j.ok) throw new Error(j.error || ('HTTP ' + r.status));",
"  if (!j.items || !j.items.length) throw new Error('没有可下载的媒体');",
"  j.sourceUrl = line;",
"  return j;",
"}",
"async function resolveAll() {",
"  var mode = getMode();",
"  var lines = splitLinks(document.getElementById('url').value);",
"  if (!lines.length) return;",
"  if (mode === 'single') lines = lines.slice(0, 1);",
"  document.getElementById('url').value = '';",
"  var okCount = 0, dupCount = 0, oldCount = 0, failCount = 0, done = 0, pcN = 0;",
"  status('解析中… 0/' + lines.length);",
"  for (var i = 0; i < lines.length; i += 3) {",
"    var batch = lines.slice(i, i + 3);",
"    var out = await Promise.all(batch.map(function (l) {",
"      return resolveOne(l).then(function (j) { return { ok: true, j: j }; },",
"        function (err) { return { ok: false, err: err.message }; });",
"    }));",
"    for (var b = 0; b < out.length; b++) {",
"      done++;",
"      if (out[b].ok && out[b].j.pcQueued) { pcN++; continue; }",
"      if (out[b].ok) {",
"        var added = addPending(out[b].j, out[b].j.sourceUrl);",
"        if (added === 'skipped') dupCount++;",
"        else {",
"          if (added === 'dup') oldCount++;",
"          okCount++; addHistory(out[b].j, out[b].j.sourceUrl);",
"        }",
"      } else failCount++;",
"    }",
"    status('解析中… ' + done + '/' + lines.length);",
"  }",
"  var msg = '✅ 加入 ' + okCount + ' 个';",
"  if (oldCount) msg += '，其中 ' + oldCount + ' 个与下载历史重复（已标 ⚠️）';",
"  if (dupCount) msg += '，跳过重复 ' + dupCount + ' 个';",
"  if (failCount) msg += '，失败 ' + failCount + ' 个';",
"  if (pcN) msg += '，YouTube ' + pcN + ' 个已发到电脑';",
"  status(msg + (mode === 'batch' && okCount ? ' —— 继续粘贴，最后点底部「打包存相册」' : ''));",
"}",
"function readPending() { try { return JSON.parse(localStorage.getItem(PKEY) || '[]'); } catch (e) { return []; } }",
"function writePending(list) { try { localStorage.setItem(PKEY, JSON.stringify(list)); } catch (e) {} renderPending(); }",
"function fmtDate(ts) { var d = new Date(ts); return (d.getMonth() + 1) + '月' + d.getDate() + '日'; }",
"function fmtTime(ts) { var d = new Date(ts); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }",
"function histMatch(u, src) {",
"  var h = readHistory();",
"  for (var i = 0; i < h.length; i++) {",
"    var e = h[i], how = '';",
"    if (src && e.src === src) how = 'link';",
"    else {",
"      var its = e.items || [];",
"      for (var k = 0; k < its.length; k++) { if (its[k].url === u) { how = 'file'; break; } }",
"    }",
"    if (how) return { t: e.first || e.t, title: e.title || '', author: e.author || '', how: how, times: e.times || 1, from: 'local' };",
"  }",
"  // 本机没有 → 再和云端备份比对（换机/重装后本机是新的，但云端可能有更全的历史）",
"  var c = cloudHist || [];",
"  for (var j = 0; j < c.length; j++) {",
"    var ce = c[j], chow = '';",
"    if (src && ce.src === src) chow = 'link';",
"    else {",
"      var cits = ce.items || [];",
"      for (var k2 = 0; k2 < cits.length; k2++) { if (cits[k2].url === u) { chow = 'file'; break; } }",
"    }",
"    if (chow) return { t: ce.first || ce.t, title: ce.title || '', author: ce.author || '', how: chow, times: ce.times || 1, from: 'cloud' };",
"  }",
"  return null;",
"}",
"var cloudHist = [];   // 云端备份里的历史（页面加载时拉一次，用于跨端查重）",
"function addPending(res, srcUrl) {",
"  var list = readPending();",
"  var v = res.items[0];",
"  for (var i = 0; i < list.length; i++) {",
"    if (list[i].u === v.url) {",
"      var t = (list[i].title || list[i].name || '').slice(0, 24);",
"      if (!confirm('这个视频已经在列表里了：' + NL() + '「' + t + '…」' + NL() + NL() + '还要再存一份重复的吗？')) return 'skipped';",
"      break;",
"    }",
"  }",
"  var dup = histMatch(v.url, srcUrl);",
"  var item = {",
"    src: srcUrl, platform: res.platform || '', author: res.author || '',",
"    title: res.title || '', published: res.published || null, thumb: res.thumb || '',",
"    addedAt: Date.now(), u: v.url, s: v.sig || '', name: v.name, label: v.label || '',",
"    size: v.bytes || 0",
"  };",
"  if (dup) item.dup = dup;",
"  list.push(item);",
"  if (list.length > 1000) list = list.slice(list.length - 1000);   // 防止 localStorage 无限增长",
"  writePending(list);",
"  return dup ? 'dup' : 'ok';",
"}",
"function removeDups() {",
"  var l = readPending();",
"  var keep = l.filter(function (x) { return !x.dup; });",
"  var n = l.length - keep.length;",
"  if (!n) { status('没有与历史重复的项'); return; }",
"  writePending(keep);",
"  status('🧹 已移除 ' + n + ' 个与下载历史重复的项');",
"}",
"function renderPending() {",
"  var list = readPending();",
"  var box = document.getElementById('pending');",
"  var cnt = document.getElementById('qcount');",
"  var bar = document.getElementById('qbar');",
"  if (cnt) cnt.textContent = list.length;",
"  var rt = document.getElementById('qretry');",
"  var retryN = list.filter(function (x) { return x.st === 'retry'; }).length;",
"  var unkN = list.filter(function (x) { return x.st === 'unknown'; }).length;",
"  if (rt) rt.textContent = (retryN ? '（' + retryN + ' 个待重试）' : '') + (unkN ? '（' + unkN + ' 个待确认）' : '');",
"  var showBar = !!(bar && getMode() === 'batch' && list.length > 0);",
"  if (bar) bar.classList.toggle('show', showBar);",
"  document.body.style.paddingBottom = showBar ? '92px' : '';",
"  if (!box) return;",
"  var dups = list.filter(function (x) { return !!x.dup; }).length;",
"  var rb = document.getElementById('rmdup');",
"  if (rb) { rb.style.display = dups ? '' : 'none'; rb.textContent = '移除重复 ' + dups; }",
"  box.innerHTML = list.map(function (e, i) {",
"    var thumb = e.thumb ? '<img class=\"pthumb\" src=\"/img?u=' + encodeURIComponent(e.thumb) + '\" onerror=\"this.remove()\">' : '';",
"    var dup = e.dup ? '<div class=\"pdup\">⚠️ ' + (e.dup.from === 'cloud' ? '云端备份里已有（本机历史没有——重装机后常见）' : '下载历史里已有') + ' · ' + (e.dup.how === 'link' ? '同一个链接' : '同一个视频文件') + ' · 上次 ' + fmtDate(e.dup.t) + ' 解析过' + (e.dup.times > 1 ? '（第 ' + e.dup.times + ' 次）' : '') + '</div>' : '';",
"    var st = '';",
"    if (e.st === 'sent') st = '<div class=\"pstate sent\">⏳ 已交给 App 下载中，完成后会自动从这里消失</div>';",
"    else if (e.st === 'retry') st = '<div class=\"pstate retry\">↺ 上次没成功：' + esc(e.err || '未知原因') + '<br>再点一次「打包存相册」就只重试这些</div>';",
"    else if (e.st === 'unknown') st = '<div class=\"pstate unknown\">⚠️ 状态未确认：' + esc(e.err || 'App 没回报结果') + '<br>很可能已经下好了 —— 建议先看相册，确认没有再用「存到相册」补</div>';",
"    var acts = '<button class=\"save\" onclick=\"saveOne(' + i + ')\">存到相册</button>' +",
"        '<button class=\"topc\" onclick=\"toPC(' + i + ')\">💻 到电脑</button>' +",
"        '<button class=\"cpb\" onclick=\"copyLink(' + i + ')\">复制直链</button>' +",
"        '<button class=\"rm\" onclick=\"removePending(' + i + ')\">移除</button>';",
"    if (e.st === 'pc') st = '<div class=\"pstate pcst\">💻 已发到电脑，Windows 代理会自动下载到固定文件夹</div>';",
"    return '<div class=\"pitem' + (e.dup ? ' isdup' : '') + (e.st === 'retry' ? ' isfail' : '') + (e.st === 'unknown' ? ' isunknown' : '') + '\">' + thumb +",
"      '<div class=\"ptitle\">' + esc(e.title || e.name) + '</div>' +",
"      dup + st +",
"      '<div class=\"pinfo\"><b>' + esc(e.author) + '</b>' +",
"      (e.published ? ' · ' + fmtDate(e.published) + ' 发布' : '') +",
"      ' · 我于 ' + fmtDate(e.addedAt) + ' ' + fmtTime(e.addedAt) + ' 粘贴' +",
"      (e.label ? ' · ' + esc(e.label) : '') + '</div>' +",
"      '<div class=\"psrc\">' + esc(e.src) + '</div>' +",
"      '<div class=\"pacts\">' + acts + '</div>' +",
"      '</div>';",
"  }).join('');",
"}",
"function removePending(i) { var l = readPending(); l.splice(i, 1); writePending(l); }",
"function clearPending() { writePending([]); status('已清空待下载列表'); }",
"function copyText(t) {",
"  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(function(){}); return; }",
"  var ta = document.createElement('textarea');",
"  ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';",
"  document.body.appendChild(ta); ta.select();",
"  try { document.execCommand('copy'); } catch (e) {}",
"  ta.remove();",
"}",
"function copyLink(i) {",
"  var e = readPending()[i]; if (!e) return;",
"  copyText(location.origin + dlHref(e.u, e.name, e.s));",
"  status('✅ 直链已复制，可粘贴到多线程下载器');",
"}",
"function toAlbum(dlUrl, name, el, size) {",
"  if (androidBridge()) {",
"    window.AndroidBridge.saveVideo(location.origin + dlUrl, name || 'video.mp4', String(size || 0));",
"    status('✅ 已加入 Android 下载队列（进度见下方进度条）');",
"    return;",
"  }",
"  if (nativeBridge()) {",
"    window.webkit.messageHandlers.saveVideo.postMessage({ url: location.origin + dlUrl, name: name || 'video.mp4', size: size || 0 });",
"    status('✅ 已交给 App 后台下载并存入相册（进度见下方进度条 / App 内队列）');",
"    return;",
"  }",
"  if (!isIOS()) { location.href = dlUrl; return; }",
"  window.__curDl = dlUrl; window.__curName = name || 'video.mp4';",
"  openIOSGuide();",
"}",
"function saveOne(i) {",
"  var e = readPending()[i]; if (!e) return;",
"  toAlbum(dlHref(e.u, e.name, e.s), e.name, null, e.size);",
"}",
"function zipPendingToAlbum() {",
"  var list = readPending();",
"  if (!list.length) { status('待下载列表是空的'); return; }",
"  if (androidBridge()) {",
"    window.AndroidBridge.saveVideoBatch(JSON.stringify(nativePayload(list)));",
    "    status('✅ ' + list.length + ' 个已交给 Android 下载（列表保留，也可再发到电脑）');",
"    return;",
"  }",
"  if (nativeBridge()) {",
"    if (batchBridge()) {",
"      var todo = list.filter(function (x) { return x.st !== 'sent'; });",
"      if (!todo.length) { status('本轮还在 App 里下载，等它跑完再打包（进度见上方卡片）'); return; }",
"      var bid = String(Date.now());",
"      for (var k = 0; k < list.length; k++) {",
"        if (list[k].st !== 'sent') { list[k].st = 'sent'; list[k].bid = bid; list[k].err = ''; }",
"      }",
"      writePending(list);",
"      writeRound({",
"        bid: bid, total: todo.length, done: 0, failed: 0, at: Date.now(),",
"        baseD: null, baseF: null            // 交付后第一次推送时再定基线",
"      });",
"      window.__roundDone = false;",
"      if (window.__roundFade) { clearTimeout(window.__roundFade); window.__roundFade = null; }",
"      try {",
"        window.webkit.messageHandlers.saveVideoBatch.postMessage(JSON.stringify(nativePayload(todo)));",
"      } catch (err) {",
"        status('批量通道调用失败，改为逐个下载…', true);",
"        return startSequential(todo);",
"      }",
"      status('✅ ' + todo.length + ' 个已交给 App 下载 —— 成功的会自动从待下载里消失，失败的会留在这里等你重试');",
"      renderPending();",
"      renderRound();",
"      return;",
"    }",
"    status('当前 App 是旧版，不支持一次打包；已自动改为逐个下载（升级 App 后可一键交给后台队列）');",
"    return startSequential(list.filter(function (x) { return x.st !== 'sent'; }));",
"  }",
"  if (!isIOS()) { status('非 iOS 设备：请在下载历史里逐条下载'); return; }",
"  openIOSGuide();",
"}",
"// 旧版 App 兼容：没有批量通道时，逐个交给原生单条下载（串行 + 逐条进度）",
"var seq = null;",
"function startSequential(list) {",
"  if (seq) stopSequential();",
"  seq = { list: list, i: 0, ok: 0, fail: 0, done: [], timer: null };",
"  setSeqBtn(true);",
"  seqNext();",
"}",
"function seqNext() {",
"  if (!seq) return;",
"  if (seq.i >= seq.list.length) return seqFinish();",
"  var x = seq.list[seq.i];",
"  status('📥 逐个下载 ' + (seq.i + 1) + '/' + seq.list.length + '：' + x.name + '（已成功 ' + seq.ok + ' · 失败 ' + seq.fail + '）');",
"  try {",
"    window.webkit.messageHandlers.saveVideo.postMessage({ url: dlFullUrl(x), name: x.name });",
"  } catch (err) {",
"    seq.fail++; seq.i++;",
"    if (seq.timer) clearTimeout(seq.timer);",
"    seq.timer = setTimeout(seqNext, 300);",
"    return;",
"  }",
"  if (seq.timer) clearTimeout(seq.timer);",
"  seq.timer = setTimeout(function () {",
"    if (!seq) return;",
"    seq.fail++; seq.i++;",
"    seqNext();",
"  }, 300000);",
"}",
"function seqDone(ok) {",
"  if (!seq) return;",
"  if (seq.timer) { clearTimeout(seq.timer); seq.timer = null; }",
"  if (ok === true) { seq.ok++; seq.done.push(seq.list[seq.i]); } else { seq.fail++; }",
"  seq.i++;",
"  seqNext();",
"}",
"function seqFinish() {",
"  var s = seq; seq = null; setSeqBtn(false);",
"  var l = readPending(), n = 0;",
"  for (var i = 0; i < l.length; i++) {",
"    var e = l[i];",
"    if (!s.list.some(function (x) { return x.u === e.u; })) continue;",
"    if (s.done.some(function (x) { return x.u === e.u; })) { l.splice(i, 1); i--; continue; }",
"    e.st = 'retry'; e.err = '未下载成功'; n++;",
"  }",
"  writePending(l);",
"  status('🏁 逐个下载结束：成功 ' + s.ok + ' · 失败 ' + s.fail + (n ? '，失败的 ' + n + ' 个已留在「待下载」里，可再打包重试' : '，已全部进相册'));",
"}",
"function stopSequential() {",
"  if (!seq) return;",
"  if (seq.timer) clearTimeout(seq.timer);",
"  var s = seq; seq = null; setSeqBtn(false);",
"  status('已停止。已完成 ' + s.ok + ' 个，剩余 ' + (s.list.length - s.i) + ' 个仍在待下载列表里');",
"}",
"function setSeqBtn(on) {",
"  var b = document.getElementById('stopseq');",
"  if (b) b.style.display = on ? '' : 'none';",
"}",
"function launchShortcut(name, url) {",
"  copyText(url);",
"  location.href = 'shortcuts://run-shortcut?name=' + encodeURIComponent(name) + '&input=text&text=' + encodeURIComponent(url);",
"}",
"function runSingleShortcut() {",
"  var dl = window.__curDl || (readPending()[0] ? location.origin + dlHref(readPending()[0].u, readPending()[0].name, readPending()[0].s) : '');",
"  if (!dl) { status('列表为空'); return; }",
"  launchShortcut(SC_ONE, dl);",
"}",
"function runZipShortcut() {",
"  var list = readPending(); if (!list.length) { status('列表为空'); return; }",
"  launchShortcut(SC_ZIP, location.origin + '/tar?items=' + b64u(list));",
"}",
"function openIOSGuide() { var g = document.getElementById('iosGuide'); if (g) g.classList.add('show'); }",
"function closeIOSGuide() { var g = document.getElementById('iosGuide'); if (g) g.classList.remove('show'); }",
"// ---------- 历史备份（重装 App 前导出，装完恢复） ----------",
"function backupJson() {",
"  return JSON.stringify({ v: 1, at: Date.now(), history: readHistory(), pending: readPending() });",
"}",
"function bkMsg(t, err) { var el = document.getElementById('bkMsg'); if (el) { el.textContent = t || ''; el.className = 'status' + (err ? ' err' : ''); } }",
"function openBackup() {",
"  var el = document.getElementById('bkText');",
"  if (el) el.value = backupJson();",
"  bkMsg('这份备份含历史 ' + readHistory().length + ' 条、待下载 ' + readPending().length + ' 个。点「复制」存到备忘录或微信，再重装 App。');",
"  var g = document.getElementById('bk'); if (g) g.classList.add('show');",
"  cloudRestore(false, false);               // 只更新状态行（本地有数据时不会覆盖）",
"}",
"function closeBackup() { var g = document.getElementById('bk'); if (g) g.classList.remove('show'); }",
"function copyBackup() {",
"  var el = document.getElementById('bkText');",
"  if (!el) return;",
"  if (!el.value) el.value = backupJson();",
"  try { el.focus(); el.select(); el.setSelectionRange(0, el.value.length); } catch (e) {}",
"  copyText(el.value);",
"  bkMsg('✅ 已复制 ' + el.value.length + ' 个字符，粘到备忘录里存好');",
"}",
"function restoreBackup() {",
"  var el = document.getElementById('bkText');",
"  var raw = el ? String(el.value || '').trim() : '';",
"  if (!raw) { bkMsg('先在框里粘贴备份文本', true); return; }",
"  var d = null;",
"  try { d = JSON.parse(raw); } catch (e) {}",
"  if (!d || (!d.history && !d.pending)) { bkMsg('这段文本不是有效备份（请完整复制，不要漏掉开头结尾）', true); return; }",
"  var nh = 0, np = 0;",
"  if (d.history && d.history.length) {",
"    nh = d.history.length;",
"    try { localStorage.setItem(HKEY, JSON.stringify(d.history.slice(0, 1000))); } catch (e) {}",
"  }",
"  if (d.pending && d.pending.length) {",
"    var list = [];",
"    for (var i = 0; i < d.pending.length && i < 300; i++) {",
"      var x = d.pending[i];",
"      delete x.st; delete x.bid; delete x.err;   // 旧一轮的状态不继承，全部当成待下载",
"      list.push(x);",
"    }",
"    np = list.length;",
"    try { localStorage.setItem(PKEY, JSON.stringify(list)); } catch (e) {}",
"  }",
"  renderHistory(); renderPending();",
"  bkMsg('✅ 已恢复：历史 ' + nh + ' 条、待下载 ' + np + ' 个');",
"}",
"// ---------- 云端备份（核心：重装 App 也不丢历史） ----------",
"var BK_AT = 'vl_bk_at';        // 上次成功上传时间",
"var BK_NORE = 'vl_norestore';  // 用户主动清空历史的时间，比它旧的云端备份不再自动恢复",
"function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }",
"function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }",
"function cloudBackup(force) {",
"  var h = readHistory();",
"  if (!h.length) return;                       // 绝不拿空历史覆盖云端",
"  var last = +lsGet(BK_AT) || 0;",
"  if (!force && Date.now() - last < 5 * 60 * 1000) return;   // 最多 5 分钟一次",
"  var body = JSON.stringify({ v: 1, history: h, pending: readPending() });",
"  var p;",
"  try { p = fetch('/api/backup', { method: 'POST', headers: { 'content-type': 'application/json' }, body: body }); }",
"  catch (e) { return; }",
"  p.then(function (r) { return r.json(); })",
"    .then(function (j) {",
"      if (j && j.ok) { lsSet(BK_AT, String(Date.now())); renderCloudLine('☁️ 已备份 · 历史 ' + j.history + ' 条 · 待下载 ' + j.pending + ' 个'); cloudHist = readHistory(); }",
"      else renderCloudLine('云备份失败：' + ((j && j.error) || '未知'), true);",
"    })",
"    .catch(function (e) { renderCloudLine('云备份失败：' + e.message, true); });",
"}",
"function cloudRestore(force, silent) {",
"  var p;",
"  try { p = fetch('/api/backup'); } catch (e) { return Promise.resolve(0); }",
"  return p.then(function (r) { return r.json(); }).then(function (j) {",
"    if (!j || !j.ok) {",
"      if (!silent) renderCloudLine('云端暂时不可用：' + ((j && j.error) || '未知'), true);",
"      return 0;",
"    }",
"    if (j.empty || !j.history || !j.history.length) {",
"      if (!silent) renderCloudLine('云端还没有备份');",
"      return 0;",
"    }",
"    var when = fmtDate(j.at) + ' ' + fmtTime(j.at);",
"    cloudHist = j.history || [];              // 供 histMatch 做跨端查重",
"    var nr = +lsGet(BK_NORE) || 0;",
"    if (!force && nr && nr > (j.at || 0)) {",
"      if (!silent) renderCloudLine('云端备份是 ' + when + '，早于你清空历史的时间，没有自动恢复');",
"      return 0;",
"    }",
"    if (!force && readHistory().length) {       // 本地已有数据：只更新状态行，不覆盖",
"      if (!silent) renderCloudLine('☁️ 云端备份：' + when + '（历史 ' + j.history.length + ' 条）');",
"      return 0;",
"    }",
"    cloudHist = j.history || [];",
"    lsSet(HKEY, JSON.stringify(j.history.slice(0, 1000)));",
"    if (j.pending && j.pending.length) {",
"      var list = [];",
"      for (var i = 0; i < j.pending.length && i < 300; i++) {",
"        var x = j.pending[i];",
"        delete x.st; delete x.bid; delete x.err;",
"        list.push(x);",
"      }",
"      lsSet(PKEY, JSON.stringify(list));",
"    }",
"    renderHistory(); renderPending();",
"    renderCloudLine('✅ 已从云端恢复 ' + when + ' 的备份：历史 ' + j.history.length + ' 条、待下载 ' + ((j.pending || []).length) + ' 个');",
"    return j.history.length;",
"  }).catch(function () { if (!silent) renderCloudLine('云端连不上', true); return 0; });",
"}",
"function renderCloudLine(t, err) {",
"  var el = document.getElementById('bkCloud');",
"  if (el) { el.textContent = t || ''; el.className = 'status' + (err ? ' err' : ''); }",
"  var f = document.getElementById('cloudFoot');",
"  if (f && t) f.textContent = t;",
"}",
"function nativeSaveDone(ok, msg) {",
"  if (seq && ok === null) return;                 // 逐个下载时的「下载中…」进度回调，忽略",
"  if (seq && ok !== null) { seqDone(ok === true); return; }",
"  if (applyRoundResult(ok, msg)) return;          // 本轮打包里的一条结果",
"  status((ok === true ? '✅ ' : ok === false ? '❌ ' : '') + msg);",
"}",
"// ---------- 本轮打包（一轮 = 一次「打包存相册」） ----------",
"// App 回报的文案有三种，必须靠前缀区分：",
"//   成功      ok=true   \"已存入相册：<文件名>\"",
"//   自动重试  ok=true   \"自动重试 1/2：<文件名>\"   ← 也是 true，不能当成功",
"//   失败      ok=false  \"<文件名>：<原因>\"",
"function isAlbumOk(msg) { return String(msg || '').indexOf('已存入相册：') === 0; }",
"function msgName(msg) {",
"  var s = String(msg || '');",
"  if (isAlbumOk(s)) return s.slice(6);",
"  var q = s.indexOf('：');",
"  return q > 0 ? s.slice(0, q) : '';",
"}",
"function readRound() { try { return JSON.parse(localStorage.getItem('vl_round') || 'null'); } catch (e) { return null; } }",
"function writeRound(r) { try { localStorage.setItem('vl_round', JSON.stringify(r)); } catch (e) {} }",
"function roundFinished(r) { return !r || !r.bid || (r.done + r.failed) >= r.total; }",
"// App 推送里的 d/f 是**累计**值，丢一次下次自动补上；逐条回调则会因切后台被挂起而丢。",
"// 所以以累计增量兜底，逐条回调只负责「是哪一个」的归属。",
"function reconcile(r, q) {",
"  if (!r || !q) return;",
"  r.sawPush = true;                              // 收到过 App 的进度 → 它确实在跑",
"  // 基线必须取「交付之后 App 的第一次推送」。取上一次推送可能已经是旧的，",
"  // 会把上一轮的完成数算进这一轮，导致本轮被提前判成结束。",
"  if (r.baseD === null || r.baseD === undefined) {",
"    r.baseD = q.d || 0;",
"    r.baseF = q.f || 0;",
"    writeRound(r);",
"    return;",
"  }",
"  var dG = (q.d || 0) - (r.baseD || 0);",
"  var fG = (q.f || 0) - (r.baseF || 0);",
"  if (dG < 0) dG = 0;",
"  if (fG < 0) fG = 0;",
"  if (dG > r.total) dG = r.total;",
"  if (fG > r.total) fG = r.total;",
"  if (dG > r.done) r.done = dG;",
"  if (fG > r.failed) r.failed = fG;",
"  if (r.done + r.failed > r.total) {",
"    // 累计值可能夹进别的下载：优先保住逐条回调算出的增量",
"    if (r.done > r.total - r.failed) r.done = r.total - r.failed;",
"    if (r.failed > r.total - r.done) r.failed = r.total - r.done;",
"  }",
"  writeRound(r);",
"}",
"function applyRoundResult(ok, msg) {",
"  var r = readRound();",
"  if (roundFinished(r)) return false;             // 没有进行中的轮次：交给普通提示",
"  var s = String(msg || '');",
"  var nm = msgName(s);",
"  if (ok === true && isAlbumOk(s)) {",
"    dropSent(r.bid, nm);",
"    r.done++;",
"  } else if (ok === false) {",
"    keepFailed(r.bid, nm, s);",
"    r.failed++;",
"    status('❌ ' + (nm || '某个视频') + ' 没成功，已放回待下载列表', true);",
"  } else {",
"    return false;                                  // null / 自动重试提示：不算结果",
"  }",
"  writeRound(r);",
"  if (!roundFinished(r)) renderRound(); else finishRound(r);",
"  return true;",
"}",
"function dropSent(bid, nm) {",
"  var l = readPending(), hit = -1;",
"  for (var i = 0; i < l.length; i++) {",
"    if (l[i].bid === bid && l[i].st === 'sent' && nm && l[i].name === nm) { hit = i; break; }",
"  }",
"  if (hit < 0) {   // 名字对不上就退一步：拿走本轮第一条还没落地的",
"    for (var j = 0; j < l.length; j++) { if (l[j].bid === bid && l[j].st === 'sent') { hit = j; break; } }",
"  }",
"  if (hit < 0) return;",
"  l.splice(hit, 1);",
"  writePending(l);",
"}",
"function keepFailed(bid, nm, err) {",
"  var l = readPending(), hit = -1;",
"  for (var i = 0; i < l.length; i++) {",
"    if (l[i].bid === bid && l[i].st === 'sent' && nm && l[i].name === nm) { hit = i; break; }",
"  }",
"  if (hit < 0) {",
"    for (var j = 0; j < l.length; j++) { if (l[j].bid === bid && l[j].st === 'sent') { hit = j; break; } }",
"  }",
"  if (hit < 0) return;",
"  l[hit].st = 'retry';",
"  l[hit].err = String(err || '').slice(0, 140);",
"  writePending(l);",
"}",
"// 收尾：把还剩「已提交」状态的条目定性。",
"// 关键判断 —— 本轮一个失败都没有时，剩下的必然都是成功的，直接删掉，绝不能标成失败。",
"function settleRemaining(r) {",
"  var l = readPending(), n = 0;",
"  for (var i = 0; i < l.length; i++) {",
"    if (l[i].bid !== r.bid || l[i].st !== 'sent') continue;",
"    if (r.failed === 0) { l.splice(i, 1); i--; continue; }",
"    l[i].st = 'unknown';",
"    l[i].err = 'App 没回报结果（切后台或换页可能丢失回调），可能已经下好了，先看相册再决定要不要重试';",
"    n++;",
"  }",
"  writePending(l);",
"  return n;",
"}",
"function finishRound(r) {",
"  var unknown = settleRemaining(r);",
"  r.endedAt = Date.now();",
"  r.unknown = unknown;",
"  writeRound(r);",
"  window.__roundDone = true;",
"  var tail;",
"  if (r.failed) tail = '，失败的 ' + r.failed + ' 个已留在「待下载」里，点「打包存相册」只重试这些';",
"  else if (unknown) tail = '，另有 ' + unknown + ' 个状态未确认，已留在列表里（很可能已经下好了，先看相册）';",
"  else tail = '，已全部进相册';",
"  status('🏁 本轮打包结束 · 成功 ' + r.done + ' · 失败 ' + r.failed + tail);",
"  renderRound();",
"  if (window.__roundFade) clearTimeout(window.__roundFade);",
"  window.__roundFade = setTimeout(function () {",
"    var b = document.getElementById('qprog');",
"    if (b) b.classList.remove('show', 'hasfail');",
"  }, 12000);",
"}",
"// App 队列已空但本轮没收回全部结果（App 被杀 / 回调丢失）：剩下的按失败放回待下载",
"// 收尾判定：队列已空但本轮没收回全部结果（App 被杀、回调丢失、页面被系统重载）。",
"// 这里**绝不直接判失败** —— 交给 settleRemaining 定性：一个失败都没有就按成功处理。",
"function lostRound() {",
"  var r = readRound();",
"  if (roundFinished(r)) return;",
"  if (r.sawPush) {",
"    // App 一直在回报进度，说明它跑过这一轮：没报失败就是都成功了",
"    r.done = r.total - r.failed;",
"    finishRound(r);",
"    return;",
"  }",
"  // 完全没收到 App 的任何数据（App 没在跑 / 被卸载）：不判成功也不判失败，只标「未确认」",
"  var l = readPending(), n = 0;",
"  for (var i = 0; i < l.length; i++) {",
"    if (l[i].bid === r.bid && l[i].st === 'sent') {",
"      l[i].st = 'unknown';",
"      l[i].err = 'App 没有回报任何进度，请确认 App 在正常运行';",
"      n++;",
"    }",
"  }",
"  if (n) writePending(l);",
"  r.unknown = n;",
"  r.endedAt = Date.now();",
"  writeRound(r);",
"  window.__roundDone = true;",
"  status('⚠️ 本轮没收到 App 的任何回报 —— ' + n + ' 个已留在「待下载」里，请确认 App 是否正常（没装或没打开）', true);",
"  renderRound();",
"}",
"// ---------- 电脑下载队列（手机远程指挥 Windows） ----------",
"function toPC(i) {",
"  var e = readPending()[i]; if (!e) return;",
"  fetch('/api/pc/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },",
"    body: JSON.stringify({ dl: location.origin + dlHref(e.u, e.name, e.s) }) })",
"    .then(function (r) { return r.json(); })",
"    .then(function (j) {",
"      if (!j.ok) { status('❌ 发到电脑失败：' + (j.error || '未知'), true); return; }",
"      var l = readPending();",
"      for (var k = 0; k < l.length; k++) { if (l[k].u === e.u) { l[k].st = 'pc'; break; } }",
"      writePending(l);",
"      status('💻 已发到电脑（队列 ' + j.count + ' 个）——Windows 代理会自动下载到固定文件夹');",
"      pcPoll(true);",
"    })",
"    .catch(function (er) { status('❌ 发送失败：' + er.message, true); });",
"}",
"function toPCAll() {",
"  var l = readPending();",
"  var todo = l.filter(function (x) { return x.st !== 'sent' && x.st !== 'pc'; });",
"  if (!todo.length) { status('没有可发送的项（都在 App 队列或已发过电脑）'); return; }",
"  var doneN = 0, okN = 0, failN = 0;",
"  var next = function () {",
"    if (doneN >= todo.length) {",
"      if (failN) status('💻 发到电脑：成功 ' + okN + ' · 失败 ' + failN + '（多为网络不通——换流量重试）', true);",
"      else status('💻 ' + okN + ' 个已全部发到电脑');",
"      pcPoll(true); return;",
"    }",
"    var e = todo[doneN];",
"    fetch('/api/pc/jobs', { method: 'POST', headers: { 'content-type': 'application/json' },",
"      body: JSON.stringify({ dl: location.origin + dlHref(e.u, e.name, e.s) }) })",
"      .then(function (r) { return r.json(); })",
"      .then(function (j) {",
"        if (j.ok) {",
"          var l2 = readPending();",
"          for (var k = 0; k < l2.length; k++) { if (l2[k].u === e.u) { l2[k].st = 'pc'; break; } }",
"          writePending(l2);",
"          okN++;",
"        } else { failN++; }",
"        doneN++; next();",
"      })",
"      .catch(function () { failN++; doneN++; next(); });",
"  };",
"  next();",
"}",
"var pcTimer = null;",
"function pcPoll(force) {",
"  fetch('/api/pc/jobs')",
"    .then(function (r) { return r.json(); })",
"    .then(function (j) {",
"      if (!j || !j.ok) return;",
"      var box = document.getElementById('pcstat');",
"      if (!box) return;",
"      var jobs = j.jobs || [];",
"      var act = jobs.filter(function (x) { return x.state === 'pending' || x.state === 'downloading'; });",
"      var dl = jobs.filter(function (x) { return x.state === 'downloading'; });",
"      var dn = jobs.filter(function (x) { return x.state === 'done' }).length;",
"      if (!jobs.length) { box.classList.remove('show'); return; }",
"      box.classList.add('show');",
"      var cur = dl[0] || act[0];",
"      box.innerHTML = '💻 电脑队列：待下 ' + jobs.filter(function(x){return x.state==='pending'}).length +",
"        ' · 下载中 ' + dl.length + ' · 已完成 ' + dn +",
"        (cur ? '<br>当前：' + esc(cur.name) + (cur.state === 'downloading' ? '（下载中…）' : '（排队中）') : '');",
"    })",
"    .catch(function () { });",
"  if (force || !pcTimer) {",
"    if (pcTimer) clearInterval(pcTimer);",
"    pcTimer = setInterval(pcPoll, 10000);",
"  }",
"}",
"// ---------- App 队列实时进度（App 端每 ~0.8 秒推一次） ----------",
"function mbOf(b) { return b > 0 ? (b / 1048576).toFixed(1) : '0'; }",
"var lastQ = null;",
"function renderRound() {",
"  var box = document.getElementById('qprog');",
"  if (!box) return;",
"  var r = readRound();",
"  if (!r || !r.bid || !r.total) return;",
"  if (!window.__roundDone && !r.endedAt) { /* 进行中 */ }",
"  var q = lastQ || {};",
"  var fin = r.done + r.failed;",
"  var ended = fin >= r.total;",
"  box.classList.add('show');",
"  if (r.failed > 0) box.classList.add('hasfail'); else box.classList.remove('hasfail');",
"  var pos = ended ? r.total : fin + 1;",
"  var pct = q.p > 0 ? Math.round(q.p * 100) : 0;",
"  var known = q.sz > 0 && !ended;",
"  var spd = ((q.s || 0) / 1048576).toFixed(2);",
"  var line2;",
"  if (ended) line2 = '本轮结束 · 成功 ' + r.done + ' · 失败 ' + r.failed + (r.failed ? '（失败的已在下方列表里）' : '');",
"  else if (q.st === '保存中') line2 = '写入相册…';",
"  else if (known) line2 = pct + '% · ' + mbOf(q.dl) + 'MB / ' + mbOf(q.sz) + 'MB · ' + spd + ' MB/s';",
"  else if (q.n) line2 = mbOf(q.dl) + 'MB 已下载 · ' + spd + ' MB/s（服务端未给总大小）';",
"  else line2 = '等待 App 回传进度…';",
"  box.innerHTML =",
"    '<div class=\"qp-t\">⬇️ 本轮第 ' + pos + '/' + r.total + ' 个' + (!ended && q.n ? '：' + esc(q.n) : '') + '</div>' +",
"    '<div class=\"qp-bar' + (known ? '' : ' indet') + '\"><i style=\"width:' + (ended ? 100 : (known ? pct : 100)) + '%\"></i></div>' +",
"    '<div class=\"qp-d\">' + line2 + '</div>' +",
"    '<div class=\"qp-s\">本轮 完成 ' + r.done + ' · 失败 ' + r.failed + ' · 剩余 ' + Math.max(0, r.total - fin) + '</div>';",
"}",
"window.nativeQueueProgress = function (q) {",
"  lastQ = q || null;",
"  var r = readRound();",
"  if (r && r.bid && !roundFinished(r)) {",
"    reconcile(r, q);                       // 用累计计数纠正丢掉的逐条回调",
"    r = readRound();",
"    if (roundFinished(r)) { finishRound(r); return; }",
"    if (Date.now() - (r.at || 0) > 15000 && (!q || q.a === 0)) {",
"      lostRound();",
"      return;",
"    }",
"    renderRound();",
"    return;",
"  }",
"  // 没有进行中的轮次（App 里单条下载等）：退回按全队列展示",
"  var box = document.getElementById('qprog');",
"  if (!box) return;",
"  if (!q || !q.t) { box.classList.remove('show', 'hasfail'); return; }",
"  box.classList.add('show');",
"  if (q.f > 0) box.classList.add('hasfail'); else box.classList.remove('hasfail');",
"  var pos = q.d + q.f + (q.a > 1 ? 1 : 0);",
"  if (pos > q.t) pos = q.t;",
"  if (pos < 1) pos = 1;",
"  var pct2 = q.p > 0 ? Math.round(q.p * 100) : 0;",
"  var known2 = q.sz > 0;",
"  var l2;",
"  if (q.st === '保存中') l2 = '写入相册…（已完成 ' + q.d + ' 个）';",
"  else if (known2) l2 = pct2 + '% · ' + mbOf(q.dl) + 'MB / ' + mbOf(q.sz) + 'MB · ' + (q.s / 1048576).toFixed(2) + ' MB/s';",
"  else l2 = mbOf(q.dl) + 'MB 已下载 · ' + (q.s / 1048576).toFixed(2) + ' MB/s（服务端未给总大小）';",
"  box.innerHTML =",
"    '<div class=\"qp-t\">⬇️ 第 ' + pos + '/' + q.t + ' 个' + (q.n ? '：' + esc(q.n) : '') + '</div>' +",
"    '<div class=\"qp-bar' + (known2 ? '' : ' indet') + '\"><i style=\"width:' + (known2 ? pct2 : 100) + '%\"></i></div>' +",
"    '<div class=\"qp-d\">' + l2 + '</div>' +",
"    '<div class=\"qp-s\">进行中 ' + q.a + ' · 完成 ' + q.d + ' · 失败 ' + q.f + '</div>';",
"};",
"function appEnv() {",
"  if (!nativeBridge()) return isIOS() ? 'Safari 网页 · 存相册走快捷指令' : '浏览器网页 · 直接下载';",
"  return batchBridge() ? 'App 新版 · 后台队列 · 一键批量' : 'App 旧版 · 无批量通道（只能逐个下）';",
"}",
"// ---------- 下载历史 ----------",
"function readHistory() { try { return JSON.parse(localStorage.getItem(HKEY) || '[]'); } catch (e) { return []; } }",
"function addHistory(result, srcUrl) {",
"  var h = readHistory();",
"  var prev = null;",
"  for (var i = 0; i < h.length; i++) { if (h[i].src === srcUrl) { prev = h[i]; break; } }",
"  h = h.filter(function (x) { return x.src !== srcUrl; });",
"  var now = Date.now();",
"  h.unshift({",
"    t: now, first: prev ? (prev.first || prev.t) : now, times: prev ? (prev.times || 1) + 1 : 1,",
"    src: srcUrl, platform: result.platform || '', author: result.author || '',",
"    title: result.title || '', published: result.published || null, thumb: result.thumb || '',",
"    items: (result.items || []).map(function (it) { return { name: it.name, label: it.label, url: it.url, sig: it.sig || '', size: it.bytes || 0 }; })",
"  });",
"  if (h.length > 1000) h = h.slice(0, 1000);",
"  try { localStorage.setItem(HKEY, JSON.stringify(h)); } catch (e) {}",
"  renderHistory();",
"  cloudBackup();                       // 自动上云（节流 5 分钟，空历史不上传）",
"}",
"function renderHistory() {",
"  var h = readHistory();",
"  var cnt = document.getElementById('histCount');",
"  var body = document.getElementById('histBody');",
"  if (!cnt || !body) return;",
"  cnt.textContent = h.length + ' 条';",
"  if (!h.length) { body.innerHTML = '<div class=\"hempty\">还没有记录。解析一次链接后就会出现在这里。</div>'; return; }",
"  body.innerHTML = h.map(function (e, i) {",
"    var d = new Date(e.t);",
"    var pad = function (n) { return (n < 10 ? '0' : '') + n; };",
"    var when = (d.getMonth() + 1) + '/' + d.getDate() + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());",
"    var files = (e.items || []).map(function (it) {",
"      return '<div class=\"hfile\"><span class=\"fn\">' + esc(it.name) + (it.label ? ' · ' + esc(it.label) : '') + '</span>' +",
"      '<a class=\"dl\" href=\"' + dlHref(it.url, it.name, it.sig) + '\" download>下载</a></div>';",
"    }).join('');",
"    return '<div class=\"hentry\">' +",
"      '<div class=\"hmeta\">' + when + ' · ' + esc(e.platform) + (e.author ? ' · ' + esc(e.author) : '') +",
"      (e.published ? ' · ' + fmtDate(e.published) + ' 发布' : '') +",
"      (e.times > 1 ? ' · 解析过 ' + e.times + ' 次' : '') + '</div>' +",
"      '<div class=\"htitle\">' + esc(e.title) + '</div>' +",
"      '<div class=\"hsrc\">来源：<a href=\"' + esc(e.src) + '\" target=\"_blank\" rel=\"noopener\">' + esc(e.src) + '</a></div>' +",
"      files +",
"      '<div class=\"hacts\"><button class=\"re\" onclick=\"reAdd(' + i + ')\">＋ 加入待下载</button></div>' +",
"      '</div>';",
"  }).join('') +",
"  '<div class=\"hclear\" onclick=\"openBackup()\">💾 导出 / 恢复备份（重装 App 前先存一份）</div>' +",
"  '<div class=\"hclear\" onclick=\"clearHistory()\">清空历史记录</div>';",
"}",
"function reAdd(i) {",
"  var h = readHistory(); var e = h[i];",
"  if (!e || !e.items || !e.items.length) { status('这条历史没有可用的视频信息'); return; }",
"  var list = readPending(); var added = 0;",
"  for (var k = 0; k < e.items.length; k++) {",
"    var it = e.items[k];",
"    if (list.some(function (x) { return x.u === it.url; })) continue;",
"    list.push({ src: e.src, platform: e.platform, author: e.author, title: e.title,",
"      published: e.published || null, addedAt: Date.now(), thumb: e.thumb || '',",
"      u: it.url, s: it.sig || '', name: it.name, label: it.label || '', size: it.size || 0 });",
"    added++;",
"  }",
"  writePending(list);",
"  status(added ? '✅ 已把 ' + added + ' 个视频加回待下载列表' : '这些视频已经在待下载列表里了');",
"  if (added) setMode('batch');",
"}",
"function clearHistory() {",
"  if (!confirm('确定清空全部下载历史？（云端备份不会动，但也不会自动恢复回来）')) return;",
"  try { localStorage.removeItem(HKEY); } catch (e) {}",
"  lsSet(BK_NORE, String(Date.now()));",
"  renderHistory();",
"}",
"// ---------- 初始化 ----------",
"window.nativeSaveDone = function (ok, msg) { nativeSaveDone(ok, msg); };",
"window.addEventListener('DOMContentLoaded', function () {",
"  applyMode(); renderPending(); renderHistory();",
"  // 上次的一轮打包被刷新打断：卡片继续显示，超时未收到结果就把没确认的放回待下载",
"  var r0 = readRound();",
"  if (r0 && r0.bid && !roundFinished(r0)) {",
"    setTimeout(function () {",
"      var r = readRound();",
"      if (roundFinished(r)) return;",
"      if (!lastQ || lastQ.a === 0) lostRound();",
"    }, 90000);",
"  } else {",
"    window.__roundDone = true;   // 已结束的轮次不再占着卡片",
"  }",
"  var envEl = document.getElementById('appenv');",
"  if (envEl) envEl.textContent = '当前环境：' + appEnv();",
"  cloudRestore(false, true).then(function (n) {",
"    if (n) status('☁️ 本地数据是空的，已从云端恢复下载历史 ' + n + ' 条（重装 App 也不怕了）');",
"    else cloudBackup();",
"  });",
"  setInterval(function () { cloudBackup(true); }, 6 * 60 * 60 * 1000);   // 开着页面时每 6 小时强制上云",
"  document.addEventListener('visibilitychange', function () {",
"    if (document.hidden) return;",
"    var last = +lsGet(BK_AT) || 0;",
"    if (Date.now() - last > 30 * 60 * 1000) cloudBackup(true);           // 回前台且距上次超 30 分钟就传一次",
"  });",
"  document.getElementById('go').addEventListener('click', resolveAll);",
"  document.getElementById('clear').addEventListener('click', function () { document.getElementById('url').value = ''; status(''); });",
"  var ta = document.getElementById('url');",
"  ta.addEventListener('paste', function (e) {",
"    var cd = e.clipboardData || window.clipboardData;",
"    var text = '';",
"    try { text = cd && cd.getData ? cd.getData('text') : ''; } catch (err) { text = ''; }",
"    if (!text || text.indexOf('http') === -1) return;",
"    e.preventDefault();",
"    var lines = splitLinks(text);",
"    if (!lines.length) return;",
"    status('收到 ' + lines.length + ' 条链接，解析中…');",
"    resolveAllWith(lines);",
"  });",
"  var u = new URLSearchParams(location.search).get('u');",
"  if (u) { document.getElementById('url').value = u; resolveAll(); }",
"});",
"async function resolveAllWith(lines) {",
"  var mode = getMode();",
"  if (mode === 'single') lines = lines.slice(0, 1);",
"  var okCount = 0, dupCount = 0, oldCount = 0, failCount = 0, done = 0, pcN = 0;",
"  for (var i = 0; i < lines.length; i += 3) {",
"    var batch = lines.slice(i, i + 3);",
"    var out = await Promise.all(batch.map(function (l) {",
"      return resolveOne(l).then(function (j) { return { ok: true, j: j }; },",
"        function (err) { return { ok: false, err: err.message }; });",
"    }));",
"    for (var b = 0; b < out.length; b++) {",
"      done++;",
"      if (out[b].ok && out[b].j.pcQueued) { pcN++; continue; }",
"      if (out[b].ok) {",
"        var added = addPending(out[b].j, out[b].j.sourceUrl);",
"        if (added === 'skipped') dupCount++;",
"        else {",
"          if (added === 'dup') oldCount++;",
"          okCount++; addHistory(out[b].j, out[b].j.sourceUrl);",
"        }",
"      } else failCount++;",
"    }",
"    status('解析中… ' + done + '/' + lines.length);",
"  }",
"  var msg = '✅ 加入 ' + okCount + ' 个';",
"  if (oldCount) msg += '，其中 ' + oldCount + ' 个与下载历史重复（已标 ⚠️）';",
"  if (dupCount) msg += '，跳过重复 ' + dupCount + ' 个';",
"  if (failCount) msg += '，失败 ' + failCount + ' 个';",
"  if (pcN) msg += '，YouTube ' + pcN + ' 个已发到电脑';",
"  status(msg + (mode === 'batch' && okCount ? ' —— 继续粘贴，最后点底部「打包存相册」' : ''));",
"}"
  ].join('\n');

  var css = [
":root { color-scheme: dark; }",
"* { box-sizing: border-box; margin: 0; }",
"body { font-family: -apple-system, 'PingFang SC', 'Noto Sans SC', sans-serif; background: radial-gradient(1200px 600px at 20% -10%, #1c2a5e 0%, #0b1020 55%) fixed; color: #eef1ff; min-height: 100vh; padding: max(16px, env(safe-area-inset-top)) 16px 40px; }",
".wrap { max-width: 520px; margin: 0 auto; }",
"h1 { font-size: 22px; margin: 18px 0 4px; }",
"h1 span { background: linear-gradient(90deg,#7aa2ff,#b18cff); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }",
".sub { color: #8b93b8; font-size: 13px; margin-bottom: 18px; }",
".box { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 14px; }",
".modes { display: flex; align-items: center; gap: 8px; margin-bottom: 10px; }",
".mode-btn { flex: 1; font-size: 14px; font-weight: 600; padding: 10px 0; border: 1px solid rgba(255,255,255,.14); background: rgba(255,255,255,.05); color: #8b93b8; border-radius: 11px; cursor: pointer; }",
".mode-btn.on { background: linear-gradient(90deg,#4f7cff,#8a5cff); color: #fff; border-color: transparent; }",
".mode-tip { font-size: 11.5px; color: #6b7398; }",
"textarea#url { width: 100%; font-size: 14px; padding: 12px 14px; border-radius: 12px; color: #fff; background: rgba(0,0,0,.35); border: 1px solid rgba(255,255,255,.14); outline: none; resize: vertical; font-family: inherit; line-height: 1.6; }",
"textarea#url:focus { border-color: #7aa2ff; }",
".row { display: flex; gap: 8px; margin-top: 10px; }",
"button { font-family: inherit; }",
"#go { flex: 1; font-size: 15px; font-weight: 600; padding: 12px 0; border: 0; border-radius: 12px; background: linear-gradient(90deg,#4f7cff,#8a5cff); color: #fff; cursor: pointer; }",
"button.ghost { flex: 0 0 auto; padding: 12px 14px; background: rgba(255,255,255,.08); color: #aab3d6; font-weight: 500; border: 0; border-radius: 12px; cursor: pointer; }",
".status { margin: 14px 2px 0; font-size: 13.5px; color: #9aa3c7; min-height: 18px; }",
".status.err { color: #ff8a8a; }",
".qprog { display: none; margin: 12px 2px 0; background: rgba(58,123,213,.14); border: 1px solid rgba(90,150,255,.35); border-radius: 13px; padding: 11px 13px; }",
".qprog.show { display: block; }",
".qprog.hasfail { background: rgba(255,120,120,.13); border-color: rgba(255,120,120,.4); }",
".qp-t { font-size: 13px; font-weight: 600; color: #dbe4ff; line-height: 1.5; word-break: break-all; }",
".qp-bar { height: 7px; border-radius: 4px; background: rgba(0,0,0,.35); overflow: hidden; margin: 8px 0 7px; }",
".qp-bar i { display: block; height: 100%; background: linear-gradient(90deg,#4f7cff,#8a5cff); transition: width .35s ease; }",
".qprog.hasfail .qp-bar i { background: linear-gradient(90deg,#ff7a7a,#ffab6b); }",
".qp-bar.indet i { background: linear-gradient(90deg,#4f7cff 0%,#8a5cff 40%,#4f7cff 80%); background-size: 220% 100%; animation: qpslide 1.3s linear infinite; }",
"@keyframes qpslide { from { background-position: 100% 0; } to { background-position: -120% 0; } }",
".qp-d { font-size: 12px; color: #b9c6ea; line-height: 1.6; }",
".qp-s { font-size: 11.5px; color: #7f8cb5; margin-top: 4px; line-height: 1.6; }",
".env { color: #4d5478; font-size: 11px; }",
".pitem { background: rgba(255,255,255,.06); border: 1px solid rgba(255,255,255,.1); border-radius: 14px; padding: 13px 14px; margin-top: 10px; }",
".pitem.isdup { border-color: rgba(255,186,84,.5); background: rgba(255,186,84,.07); }",
".pitem.isfail { border-color: rgba(255,110,110,.55); background: rgba(255,110,110,.06); }",
".pstate { font-size: 11.5px; border-radius: 8px; padding: 6px 9px; margin-top: 8px; line-height: 1.55; }",
".pstate.sent { color: #9fd0ff; background: rgba(90,160,255,.14); border: 1px solid rgba(90,160,255,.3); }",
".pstate.retry { color: #ffb3b3; background: rgba(255,120,120,.14); border: 1px solid rgba(255,120,120,.32); }",
".pstate.unknown { color: #ffce7a; background: rgba(255,186,84,.12); border: 1px solid rgba(255,186,84,.3); }",
".pstate.pcst { color: #7fe0a8; background: rgba(80,220,140,.12); border: 1px solid rgba(80,220,140,.3); }",
".pcstat { display: none; margin: 10px 2px 0; background: rgba(80,220,140,.08); border: 1px solid rgba(80,220,140,.25); border-radius: 12px; padding: 10px 13px; font-size: 12.5px; color: #9fd8b4; line-height: 1.7; }",
".pcstat.show { display: block; }",
".qbar .topcall { background: rgba(80,220,140,.16); color: #7fe0a8; }",
".pitem.isunknown { border-color: rgba(255,186,84,.5); }",
".pdup { font-size: 11.5px; color: #ffce7a; background: rgba(255,186,84,.14); border: 1px solid rgba(255,186,84,.3); border-radius: 8px; padding: 6px 9px; margin-top: 8px; line-height: 1.5; }",
".pthumb { width: 100%; max-height: 170px; object-fit: cover; border-radius: 10px; display: block; margin-bottom: 10px; background: rgba(0,0,0,.3); }",
".ptitle { font-size: 14px; font-weight: 600; line-height: 1.45; word-break: break-word; }",
".pinfo { font-size: 11.5px; color: #8b93b8; margin-top: 5px; line-height: 1.6; }",
".pinfo b { color: #b9c1de; font-weight: 600; }",
".psrc { font-size: 11px; color: #6b7398; margin-top: 6px; word-break: break-all; }",
".pacts { display: flex; gap: 8px; margin-top: 10px; }",
".pacts button { font-size: 13px; font-weight: 600; border: 0; border-radius: 9px; padding: 8px 14px; cursor: pointer; }",
".pacts .save { background: linear-gradient(90deg,#3a7bd5,#00a3ff); color: #fff; }",
".pacts .topc { background: rgba(80,220,140,.16); color: #7fe0a8; }",
".pacts .cpb { background: rgba(255,255,255,.08); color: #9fb0e8; font-weight: 500; }",
".pacts .rm { background: rgba(255,255,255,.08); color: #aab3d6; font-weight: 500; }",
".qbar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 40; display: none; background: #16203c; border-top: 1px solid rgba(255,255,255,.14); padding: 10px 14px max(10px, env(safe-area-inset-bottom)); }",
".qbar.show { display: block; }",
".qbar-in { max-width: 520px; margin: 0 auto; display: flex; align-items: center; gap: 10px; }",
".qbar-txt { flex: 1; font-size: 13.5px; color: #c3cae4; white-space: nowrap; }",
".qbar-txt b { color: #ffd479; }",
".qbar button { font-size: 13.5px; white-space: nowrap; font-weight: 700; border: 0; border-radius: 10px; padding: 10px 14px; cursor: pointer; }",
".qbar .clr { background: rgba(255,255,255,.1); color: #aab3d6; font-weight: 500; }",
".qbar .rmdup { background: rgba(255,186,84,.16); color: #ffce7a; }",
".qbar .stopseq { background: rgba(255,120,120,.2); color: #ffb3b3; }",
".qbar .go { background: linear-gradient(90deg,#3a7bd5,#00a3ff); color: #fff; }",
".hist { margin-top: 22px; background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.1); border-radius: 16px; overflow: hidden; }",
".hist-h { padding: 14px 16px; font-size: 14.5px; font-weight: 700; cursor: pointer; display: flex; align-items: center; justify-content: space-between; }",
".hist-h .n { color: #9db8ff; font-weight: 600; }",
".hist-body { display: none; border-top: 1px solid rgba(255,255,255,.08); }",
".hist.open .hist-body { display: block; }",
".hentry { padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,.06); }",
".hentry:last-child { border-bottom: 0; }",
".hmeta { font-size: 11.5px; color: #6b7398; margin-bottom: 4px; }",
".htitle { font-size: 13.5px; color: #dde2f5; line-height: 1.5; margin-bottom: 6px; word-break: break-word; }",
".hsrc { font-size: 11.5px; color: #7f88ad; word-break: break-all; margin-bottom: 8px; }",
".hsrc a { color: #9db8ff; text-decoration: none; }",
".hfile { display: flex; align-items: center; justify-content: space-between; gap: 8px; background: rgba(0,0,0,.25); border-radius: 9px; padding: 7px 10px; margin-bottom: 6px; }",
".hfile .fn { font-size: 12px; color: #b9c1de; word-break: break-all; flex: 1; }",
".hfile .dl { font-size: 12px; font-weight: 700; color: #fff; background: #2f9e63; padding: 6px 12px; border-radius: 8px; text-decoration: none; white-space: nowrap; }",
".hacts { margin-top: 8px; }",
".hacts .re { font-size: 12px; font-weight: 600; color: #ffd479; background: rgba(255,180,60,.14); border: 0; border-radius: 8px; padding: 7px 12px; cursor: pointer; }",
".hempty { padding: 18px 16px; font-size: 13px; color: #6b7398; text-align: center; }",
".hclear { padding: 11px 16px; font-size: 12.5px; color: #8b93b8; text-align: center; border-top: 1px solid rgba(255,255,255,.06); cursor: pointer; }",
".bktext { width: 100%; min-height: 160px; font-family: ui-monospace, Menlo, monospace; font-size: 11px; line-height: 1.5; padding: 10px 12px; border-radius: 10px; color: #dfe6ff; background: rgba(0,0,0,.45); border: 1px solid rgba(255,255,255,.16); outline: none; resize: vertical; }",
".guide { display: none; position: fixed; inset: 0; background: rgba(4,8,20,.78); z-index: 50; padding: max(18px, env(safe-area-inset-top)) 14px 24px; overflow-y: auto; }",
".guide.show { display: block; }",
".guide-box { max-width: 520px; margin: 0 auto; background: #131a33; border: 1px solid rgba(255,255,255,.12); border-radius: 18px; padding: 20px 18px 22px; position: relative; }",
".guide-x { position: absolute; top: 10px; right: 12px; background: none; border: 0; color: #7f88ad; font-size: 26px; line-height: 1; cursor: pointer; padding: 4px 8px; }",
".guide h3 { font-size: 17px; margin-bottom: 8px; }",
".guide-note { font-size: 12.5px; color: #8b93b8; line-height: 1.6; margin-bottom: 16px; }",
".guide-sub { font-size: 12.5px; color: #9299bb; margin: 0 0 8px; }",
".guide-sec { background: rgba(255,255,255,.05); border-radius: 12px; padding: 13px 14px; margin-bottom: 12px; }",
".guide-h { font-size: 14px; font-weight: 700; margin-bottom: 9px; }",
".guide ol { margin: 0; padding-left: 20px; }",
".guide li { font-size: 13px; line-height: 1.75; color: #c3cae4; margin-bottom: 3px; }",
".guide b { color: #eef1ff; }",
".guide code { background: rgba(122,162,255,.16); color: #9db8ff; padding: 1px 6px; border-radius: 5px; font-size: 12.5px; }",
".tag { font-size: 10px; font-weight: 700; padding: 2px 7px; border-radius: 99px; margin-right: 6px; vertical-align: 1px; }",
".tag.rec { background: rgba(47,191,113,.2); color: #7affb0; }",
".guide-btn { margin-top: 12px; text-align: center; font-size: 14px; font-weight: 700; color: #fff; background: linear-gradient(90deg,#2fbf71,#20a05a); padding: 11px 0; border-radius: 11px; cursor: pointer; }",
".foot { margin-top: 22px; font-size: 12px; color: #5d6485; line-height: 1.6; }",
".foot a { color: #9db8ff; }"
  ].join('\n');

  var html = [
'<!DOCTYPE html>',
'<html lang="zh-CN">',
'<head>',
'<meta charset="utf-8">',
'<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">',
'<meta name="apple-mobile-web-app-capable" content="yes">',
'<meta name="apple-mobile-web-app-title" content="VideoLoader">',
'<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">',
'<meta name="theme-color" content="#0b1020">',
'<link rel="manifest" href="/manifest.webmanifest">',
'<link rel="apple-touch-icon" href="/apple-touch-icon.png">',
'<link rel="icon" type="image/png" sizes="192x192" href="/icon-192.png">',
'<title>VideoLoader · 粘贴链接下载视频</title>',
'<style>',
css,
'</style>',
'</head>',
'<body>',
'<div class="wrap">',
'  <h1>Video<span>Loader</span></h1>',
'  <div class="sub">粘贴 X(Twitter) 推文 / Telegram 帖子 / 视频直链，解析后存入相册</div>',
'  <div class="box">',
'    <div class="modes">',
'      <button class="mode-btn" data-m="single" onclick="setMode(this.getAttribute(\'data-m\'))">单个</button>',
'      <button class="mode-btn" data-m="batch" onclick="setMode(this.getAttribute(\'data-m\'))">打包</button>',
'      <span class="mode-tip" id="modeTip"></span>',
'    </div>',
'    <textarea id="url" rows="4" placeholder="粘贴链接即自动解析（可连续粘贴多条）" autocapitalize="off" autocorrect="off" spellcheck="false"></textarea>',
'    <div class="row">',
'      <button id="go">解析</button>',
'      <button id="clear" class="ghost">清空</button>',
'    </div>',
'  </div>',
'  <div id="status" class="status"></div>',
'  <div id="qprog" class="qprog"></div>',
'  <div id="pcstat" class="pcstat"></div>',
'  <div id="pending" class="pending"></div>',
'  <div class="hist" id="hist">',
'    <div class="hist-h" onclick="document.getElementById(\'hist\').classList.toggle(\'open\')">',
'      <span>📜 下载历史</span><span class="n" id="histCount">0 条</span>',
'    </div>',
'    <div class="hist-body" id="histBody"></div>',
'  </div>',
'  <div class="foot">',
'    仅下载公开可访问的内容，请尊重原作者版权，仅供个人学习使用。<br>',
'    iOS 存相册：Safari 用户点「存到相册」按指引配一次快捷指令；App 用户点「存到相册」直接进相册。<br>',
'    iOS 备选安装：Safari 打开 <a href="/profile">描述文件 /profile</a> → 设置 → 已下载描述文件 → 安装。<br>',
'    <span style="color:#4d5478">网页 v7.5.1 · App v6.4 · Android v1.0 —— 两个版本号独立，页脚以「当前环境」那行为准</span><br>',
'    <span class="env">💾 记录会自动备份到云端，重装 App 后自动恢复 · <a href="javascript:void(0)" onclick="openBackup()" style="color:#7aa2ff">备份详情</a></span><br>',
'    <span id="cloudFoot" class="env"></span>',
'    <span id="appenv" class="env"></span>',
'  </div>',
'</div>',
'<div id="qbar" class="qbar">',
'  <div class="qbar-in">',
'    <span class="qbar-txt">待下载 <b id="qcount">0</b> 个<span id="qretry"></span></span>',
'    <button class="stopseq" id="stopseq" onclick="stopSequential()" style="display:none">停止下载</button>',
'    <button class="rmdup" id="rmdup" onclick="removeDups()" style="display:none">移除重复</button>',
'    <button class="topcall" onclick="toPCAll()">💻 全部发到电脑</button>',
'    <button class="clr" onclick="clearPending()">清空</button>',
'    <button class="go" onclick="zipPendingToAlbum()">打包存相册</button>',
'  </div>',
'</div>',
'<div id="bk" class="guide" onclick="if(event.target===this)closeBackup()">',
'  <div class="guide-box">',
'    <button class="guide-x" onclick="closeBackup()">×</button>',
'    <h3>导出 / 恢复下载历史</h3>',
'    <p class="guide-note">下载历史和待下载列表存在 App 的容器里。<b>重装 App（比如签名 7 天到期后重签）有可能把它们清掉</b>，所以重装前先导出一份。装好后把这段文本粘回来点「恢复」即可。</p>',
'    <textarea id="bkText" class="bktext" spellcheck="false" autocapitalize="off" autocorrect="off" placeholder="点上面的「导出」会填好内容；重装后把备份粘到这里再点「恢复」"></textarea>',
'    <div class="row" style="margin-top:10px">',
'      <button class="go" id="bkCopy" onclick="copyBackup()">复制这段备份</button>',
'      <button class="ghost" onclick="restoreBackup()">从这段恢复</button>',
'    </div>',
'    <div id="bkMsg" class="status" style="margin-left:0"></div>',
'    <div class="guide-sec" style="margin-top:14px">',
'      <div class="guide-h"><span class="tag rec">自动</span>云端备份（重装 App 也不会丢）</div>',
'      <p class="guide-note">有改动就自动上传到云端（最多 5 分钟一次）。重装 App 后打开这个网页，如果本地是空的，会<b>自动把云端的记录拉回来</b>，你不用做任何事。</p>',
'      <div id="bkCloud" class="status" style="margin-left:0"></div>',
'      <div class="row" style="margin-top:8px">',
'        <button class="go" onclick="cloudBackup(true)">立即备份到云端</button>',
'        <button class="ghost" onclick="cloudRestore(true)">从云端恢复</button>',
'      </div>',
'    </div>',
'  </div>',
'</div>',
'<div id="iosGuide" class="guide" onclick="if(event.target===this)closeIOSGuide()">',
'  <div class="guide-box">',
'    <button class="guide-x" onclick="closeIOSGuide()">×</button>',
'    <h3>iPhone 存进相册（配一次，之后一键）</h3>',
'    <p class="guide-note">iOS 不允许网页把文件直接写进「照片」App——苹果的沙箱限制，任何下载网站都一样。用下面的快捷指令就能一键进相册，完全免费。</p>',
'    <div class="guide-sec">',
'      <div class="guide-h"><span class="tag rec">单条</span>配一个「<code>保存视频到相册</code>」</div>',
'      <ol>',
'        <li>系统「快捷指令」App → 右上角 + 新建 → 命名为：<code>保存视频到相册</code></li>',
'        <li>添加「<b>获取 URL 内容</b>」，URL 用变量「<b>快捷指令输入</b>」，方法 GET</li>',
'        <li>添加「<b>存储到照片相册</b>」</li>',
'      </ol>',
'      <div class="guide-btn" onclick="runSingleShortcut()">已配好，一键存相册</div>',
'    </div>',
'    <div class="guide-sec">',
'      <div class="guide-h"><span class="tag rec">批量</span>再配一个「<code>批量存相册</code>」</div>',
'      <ol>',
'        <li>新建快捷指令，命名为：<code>批量存相册</code></li>',
'        <li>添加「<b>获取 URL 内容</b>」，URL 用变量「<b>快捷指令输入</b>」</li>',
'        <li>添加「<b>解压缩归档</b>」（支持 zip/tar）</li>',
'        <li>添加「<b>存储到照片相册</b>」（类型不符时用「重复每个项目」包住再存）</li>',
'      </ol>',
'      <div class="guide-btn" onclick="runZipShortcut()">已配好，打包并交给快捷指令</div>',
'    </div>',
'    <p class="guide-note" style="margin:14px 0 0">每次调用都会把链接复制到剪贴板作为兜底；Android / 电脑点「存到相册」直接下载。</p>',
'  </div>',
'</div>',
'<script>',
js,
'</' + 'script>',
'</body>',
'</html>'
  ].join('\n');

  return html;
}
