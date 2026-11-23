import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CF = path.join(ROOT, 'bin', 'cloudflared.exe');
const CFG = path.join(ROOT, 'config.json');

const stamp = () => new Date().toLocaleTimeString('zh-CN', { hour12: false });
const log = (...a) => console.log(`[${stamp()}]`, ...a);

function readCfg() {
  try { return JSON.parse(fs.readFileSync(CFG, 'utf8')); } catch { return {}; }
}
function writePublicUrl(url) {
  const c = readCfg();
  if (c.publicUrl === url) return;
  c.publicUrl = url;
  fs.writeFileSync(CFG, JSON.stringify(c, null, 2), 'utf8');
  log('已把公网地址写入 config.json');
}

// ---------- 1. 启动 Cloudflare 隧道 ----------
// 注意：沙箱里 spawn 不能管道（EPERM），所以输出重定向到文件，再轮询读取。
const LOG_FILE = path.join(ROOT, 'tunnel.log');
const logFd = fs.openSync(LOG_FILE, 'w');
const cf = spawn(CF, ['tunnel', '--url', 'http://127.0.0.1:8787', '--no-autoupdate'], {
  stdio: ['ignore', logFd, logFd],
});
let tunnelUrl = '';

// 轮询日志文件找公网地址
const poller = setInterval(() => {
  if (tunnelUrl) return;
  try {
    const s = fs.readFileSync(LOG_FILE, 'utf8');
    const m = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/.exec(s);
    if (m) {
      tunnelUrl = m[0];
      clearInterval(poller);
      log('公网地址：' + tunnelUrl);
      writePublicUrl(tunnelUrl);
      startServer();
    }
  } catch {}
}, 800);
setTimeout(() => { if (!tunnelUrl) log('12 秒内没拿到公网地址'); }, 12000);

cf.on('exit', (code) => {
  log('隧道进程退出（code ' + code + '），10 秒后重启');
  setTimeout(() => process.exit(1), 1000);
});

// ---------- 2. 启动翻译服务 ----------
let serverProc = null;
let booting = false;
function startServer() {
  if (serverProc) return;
  serverProc = spawn(process.execPath, ['server.mjs'], { stdio: 'inherit', cwd: ROOT, env: process.env });
  log('翻译服务已启动（pid ' + serverProc.pid + '）');
  serverProc.on('exit', (code) => {
    log('翻译服务退出（code ' + code + '），3 秒后重启');
    serverProc = null;
    setTimeout(startServer, 3000);
  });
}

function boot() {
  if (booting) return;
  booting = true;
  // 兜底：12 秒内没拿到公网地址也先把服务起来（先用局域网地址）
  setTimeout(() => {
    if (!serverProc) { log('未拿到公网地址，先用局域网模式启动'); startServer(); }
  }, 12000);
}

// ---------- 3. 退出清理 ----------
function shutdown() {
  log('正在关闭…');
  try { serverProc && serverProc.kill(); } catch {}
  try { cf.kill(); } catch {}
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

log('启动中：隧道 + 翻译服务');
boot();
