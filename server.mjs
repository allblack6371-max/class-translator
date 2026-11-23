// 课堂同传 - 局域网实时字幕服务器
// 主机浏览器采集麦克风音频 → 本服务 → whisper-server 韩语识别 → DeepSeek 翻译 → 广播给扫码观众
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const UPLOAD_DIR = path.join(ROOT, 'uploads');
fs.mkdirSync(UPLOAD_DIR, { recursive: true });
const PUBLIC = path.join(ROOT, 'public');

// ---------- 配置 ----------
const DEFAULT_CONFIG = {
  port: 8787,
  httpsPort: 8443,
  publicUrl: '',
  host: '0.0.0.0',
  whisperPort: 8789,
  model: 'models/ggml-base-q5_1.bin',
  asrLang: 'auto',
  asrPrompt: '',
  threads: 8,
  deepseekApiKey: '',
  llmBaseUrl: 'https://api.deepseek.com/chat/completions',
  llmModel: 'deepseek-chat',
  contextLines: 10,
  domain: '',
  glossary: '',
};
function loadConfig() {
  const cfg = { ...DEFAULT_CONFIG };
  try {
    Object.assign(cfg, JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8')));
  } catch { /* 无配置文件时用默认 */ }
  cfg.deepseekApiKey = cfg.deepseekApiKey || process.env.DEEPSEEK_API_KEY || '';
  return cfg;
}
const cfg = loadConfig();
const BIN = path.resolve(ROOT, cfg.binDir || 'bin/whisper/Release');
const WHISPER_SERVER = path.join(BIN, 'whisper-server.exe');
const MODEL_REL = path.isAbsolute(cfg.model) ? cfg.model : path.relative(ROOT, path.join(ROOT, cfg.model));
const WHISPER_URL = `http://127.0.0.1:${cfg.whisperPort}`;

if (!fs.existsSync(WHISPER_SERVER)) { console.error('[fatal] 找不到 whisper-server.exe:', WHISPER_SERVER); process.exit(1); }
if (!fs.existsSync(path.join(ROOT, cfg.model))) { console.error('[fatal] 找不到模型:', path.join(ROOT, cfg.model)); process.exit(1); }

// ---------- 状态 ----------
const viewers = new Set();
const history = []; // 老师方向 { id, ko, zh, t, dir }

// ---------- 主机（录音端）状态：用于控制台远程观察 ----------
let hostConns = 0;
let lastAudioAt = 0;
let lastLevelAt = 0;
let hostRecording = false;
function hostState() {
  // 录音中 = 录音端在持续发 level 心跳（静音时也会发），停止后 3 秒内变回未收音
  return { online: hostConns > 0, count: hostConns, recording: Date.now() - lastLevelAt < 3000 };
}
function broadcastHostState() { broadcast({ type: 'hostState', ...hostState() }); }
// 录音状态靠 level 心跳推算，需要定时广播（静音时 level 仍在发，停止后 3 秒内掉出窗口）
setInterval(() => { if (hostConns > 0) broadcastHostState(); }, 1000);
const talks = [];   // 学生方向 { id, zh, ko, t }
const chat = [];    // 课堂聊天室 { id, from, sid, zh, ko, t, via }
let chatSeq = 0;

// ---------- 课堂记录（一节课一个 JSON 文件，随时落盘） ----------
const SESSION_DIR = path.join(ROOT, 'sessions');
try { fs.mkdirSync(SESSION_DIR, { recursive: true }); } catch {}
function stamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}
let sessionStart = new Date();
let sessionFile = path.join(SESSION_DIR, `课-${stamp(sessionStart)}.json`);
let persistTimer = null;
function sessionEntries() {
  return [
    ...history.map((x) => ({ ...x, kind: 'lecture' })),
    ...talks.map((x) => ({ ...x, kind: 'talk' })),
    ...chat.map((x) => ({ ...x, kind: 'chat' })),
  ].sort((a, b) => a.t - b.t);
}
function persistNow() {
  try {
    fs.writeFileSync(sessionFile, JSON.stringify({ start: sessionStart.toISOString(), entries: sessionEntries() }, null, 1));
  } catch (e) { console.error('[session]', e.message); }
}
function schedulePersist() {
  if (persistTimer) return;
  persistTimer = setTimeout(() => { persistTimer = null; persistNow(); }, 1000);
}
let seq = 0;

// 服务重启后从最近一节课的文件恢复记录：刷新页面、重启服务都不丢
try {
  const files = fs.readdirSync(SESSION_DIR).filter((f) => f.endsWith('.json')).sort();
  if (files.length) {
    const latest = files[files.length - 1];
    const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, latest), 'utf8'));
    let maxId = 0;
    for (const e of data.entries || []) {
      if (e.id && e.id > maxId) maxId = e.id;
      if (e.kind === 'lecture') history.push({ id: e.id, ko: e.ko, zh: e.zh, t: e.t, dir: 'ko2zh' });
      else if (e.kind === 'talk') talks.push({ id: e.id, zh: e.zh, ko: e.ko, t: e.t, via: e.via, dir: 'zh2ko' });
      else if (e.kind === 'chat') chat.push(e);
    }
    seq = maxId;
    chatSeq = chat.reduce((m, x) => Math.max(m, x.id || 0), 0);
    if (data.start) sessionStart = new Date(data.start);
    sessionFile = path.join(SESSION_DIR, latest);
    console.log(`[session] 已恢复 ${latest}（${(data.entries || []).length} 条，seq=${seq}）`);
  }
} catch (e) { console.error('[session] restore:', e.message); }
const queue = [];
let busy = false;
let whisperReady = false;
let lastAsrMs = 0;
let mode = 'lecture';    // lecture=老师讲课(韩/英→中) | ask=学生提问(中→韩)
let talkEnabled = false; // 学生提问默认关闭，需老师在主机页手动打开
let stuVoiceEnabled = false; // 学生用手机麦克风语音提问（老师控制）
const stuQueue = [];
let stuBusy = false;

// ---------- 工具 ----------
function lanIPs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family === 'IPv4' && !a.internal) out.push({ name, address: a.address });
    }
  }
  out.sort((a, b) => {
    const score = (ip) => (/^192\.168\./.test(ip) ? 0 : /^10\./.test(ip) ? 1 : /^172\.(1[6-9]|2\d|3[01])\./.test(ip) ? 2 : 3);
    return score(a.address) - score(b.address);
  });
  return out;
}

// whisper 在静音/噪音段生成的典型幻觉（完整短语匹配，避免误杀正常课堂用语）
const HALLUCINATION_RE =
  /^(请不吝|请给我|请订阅|请关注|请点赞|请转发|请打赏|字幕由|字幕\s*by|字幕[:：]|感谢观看|谢谢观看|感谢订阅|谢谢订阅|订阅频道|点赞订阅|明明白白|明镜与点点|Amara\.org|www\.|https?:\/\/|本文由|本视频由|关注我们|欢迎订阅|欢迎观看|字幕组|翻译[:：]|校对[:：]|制作[:：])/i;

function cleanText(s) {
  if (!s) return '';
  let t = String(s)
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\([^)]*\)/g, ' ')
    .replace(/[♫♪…]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) return '';
  const m = t.match(/^(.{4,})\1+$/);
  if (m) t = m[1].trim();
  if (t.length < 2) return '';
  // 纯标点、纯符号、纯数字
  if (/^[\p{P}\p{S}\s\d]+$/u.test(t)) return '';
  // 典型 whisper 静音幻觉
  if (HALLUCINATION_RE.test(t)) return '';
  // 单字/双字反复（噪音段常见）
  const chars = t.replace(/\s/g, '');
  if (chars.length >= 5 && new Set(chars).size <= 2) return '';
  return t;
}

function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const ws of viewers) if (ws.readyState === 1) ws.send(msg);
}

// ---------- whisper-server 常驻进程 ----------
let whisperProc = null;
let restartCount = 0;
function startWhisperServer() {
  const args = [
    '-m', MODEL_REL,
    '-l', cfg.asrLang,
    '-t', String(cfg.threads),
    '--host', '127.0.0.1',
    '--port', String(cfg.whisperPort),
    '--tmp-dir', os.tmpdir(),
  ];
  if (cfg.asrPrompt) args.push('--prompt', cfg.asrPrompt);
  // 注意：stdio:'pipe' 在受限沙箱会被拦（EPERM）；'ignore' 在本机实测会让 whisper-server 的 DLL 初始化失败（0xC0000142）。
  // 'inherit' 是唯一稳定的方式，日志会直接打到当前控制台。
  whisperProc = spawn(WHISPER_SERVER, args, { cwd: ROOT, windowsHide: true, stdio: 'inherit' });
  whisperProc.on('exit', (code) => {
    console.error('[whisper] 进程退出，code =', code);
    whisperReady = false;
    if (!shuttingDown && restartCount < 5) {
      restartCount++;
      setTimeout(startWhisperServer, 3000 * restartCount);
    }
  });
}

async function waitWhisperReady(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(WHISPER_URL + '/', { signal: AbortSignal.timeout(1200) });
      if (r.ok || r.status === 404) return true;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

const ALLOWED_LANGS = new Set(['korean', 'english', 'chinese']);

async function transcribe(buf, langOverride) {
  const fd = new FormData();
  fd.append('file', new Blob([buf], { type: 'audio/wav' }), 'seg.wav');
  fd.append('language', langOverride || cfg.asrLang);
  fd.append('response_format', 'verbose_json');
  fd.append('beam_size', '1');
  fd.append('best_of', '1');
  fd.append('no_context', 'true');
  fd.append('temperature', '0');
  // 中文提问：whisper 默认倾向输出繁体，用 initial prompt 引导成简体
  if (langOverride === 'zh') fd.append('prompt', '以下是普通话的句子，用简体中文转写。');
  const r = await fetch(WHISPER_URL + '/inference', {
    method: 'POST',
    body: fd,
    signal: AbortSignal.timeout(60000),
  });
  if (!r.ok) throw new Error(`whisper-server ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  const segs = Array.isArray(j.segments) ? j.segments : [];
  const avgLp = segs.length ? segs.reduce((s, x) => s + (x.avg_logprob ?? 0), 0) / segs.length : 0;
  const nsp = segs.length ? Math.max(...segs.map((x) => x.no_speech_prob ?? 0)) : 0;
  return {
    text: (j.text || '').trim(),
    lang: String(j.language || '').toLowerCase(),
    avgLp,
    nsp,
  };
}

// 计算 WAV（16bit PCM）的 RMS，用来识别静音/环境噪音段
function wavRms(buf) {
  if (buf.length <= 44) return 0;
  const n = (buf.length - 44) >> 1;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const v = buf.readInt16LE(44 + i * 2) / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / n);
}

// ---------- 翻译 ----------
const PROMPT_KO2ZH = `你是课堂实时同声传译引擎，服务于“韩国老师讲课、中国学生听”的课堂。
输入是语音识别得到的原始文本，可能有识别错误、断句不完整、夹带语气词和口头禅。
对话历史里给了你已经确认过的上下文（用户消息是原文，助手消息是译文），请利用上下文纠正当前这句的识别错误、补全被切断的语义。

规则：
1. 输入是韩语或英语时，翻译成自然、准确、口语化的中文。
2. 结合上下文把被切断的句子接续成完整语义，不要逐词硬译，也不要重复原文。
3. 英文术语、课程名翻译成中文通行译法，并用括号附上英文原文，格式必须是“中文（英文）”，例如：object detection→目标检测（object detection）、detection→检测（detection）、loss function→损失函数（loss function）。同一句话里同一术语只在第一次出现时加括号。人名、公司名、产品名等专有名词直接保留原文，不要加括号。
4. 如果输入只是噪音、无意义的语气词、字幕署名、色情暴力等明显不属于课堂的内容，或者根本不是课堂内容，只输出 <skip>。
5. 只输出译文一行，不要引号、不要前缀、不要任何解释。`;

// 快速版：规则压到最短，只用于第一遍出稿（随后被完整上下文的重译覆盖）
const PROMPT_KO2ZH_FAST = `课堂同声传译：韩语/英语 → 中文。只输出一行中文译文，不要解释、不要引号。
英文术语译成中文，首次出现时括号附英文，如 目标检测（object detection）；人名公司名保留。无意义内容只输出 <skip>。`;

const PROMPT_ZH2KO = `你是课堂实时同声传译引擎，服务于“中国学生向韩国老师提问”的场景。
输入是中文，请翻译成自然、礼貌的韩语（课堂场合用 해요체／하십시오체，不要用平语）。
对话历史里给了已经确认过的上下文（用户消息是中文，助手消息是韩语），请保持术语和称谓一致。
规则：
1. 只输出韩语译文一行，不要引号、不要前缀、不要解释。
2. 如果输入是无意义内容，只输出 <skip>。`;

async function translateText(text, dir = 'ko2zh', onDelta = null, opts = {}) {
  if (!cfg.deepseekApiKey) return null;
  const zh2ko = dir === 'zh2ko';
  let sys = zh2ko ? PROMPT_ZH2KO : PROMPT_KO2ZH;
  if (opts.fast && !zh2ko) sys = PROMPT_KO2ZH_FAST;
  const extra = [];
  if (cfg.domain) extra.push(`本课程领域：${cfg.domain}。请用该领域的通行术语翻译，保证术语一致。`);
  if (cfg.glossary && String(cfg.glossary).trim()) {
    extra.push(`术语对照（原文 = 译文，遇到必须按对照译）：\n${String(cfg.glossary).trim().slice(0, 2000)}`);
  }
  if (extra.length) sys += '\n\n【课堂补充信息】\n' + extra.join('\n');
  const ctxLines = opts.fast ? 0 : cfg.contextLines;
  const ctx = [];
  if (ctxLines > 0) {
    if (zh2ko) {
      for (const h of talks.slice(-ctxLines)) {
        if (h.zh && h.ko) { ctx.push({ role: 'user', content: h.zh }); ctx.push({ role: 'assistant', content: h.ko }); }
      }
    } else {
      for (const h of history.slice(-ctxLines)) {
        if (opts.excludeId && h.id === opts.excludeId) continue;
        if (h.ko && h.zh) { ctx.push({ role: 'user', content: h.ko }); ctx.push({ role: 'assistant', content: h.zh }); }
      }
    }
  }
  const streaming = typeof onDelta === 'function';
  try {
    const r = await fetch(cfg.llmBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.deepseekApiKey}` },
      body: JSON.stringify({
        model: cfg.llmModel,
        messages: [{ role: 'system', content: sys }, ...ctx, { role: 'user', content: text }],
        temperature: 0.2,
        max_tokens: opts.fast ? 140 : 250,
        stream: streaming,
      }),
      signal: AbortSignal.timeout(15000),
    });
    if (!r.ok) { console.error('[llm]', r.status, (await r.text()).slice(0, 200)); return null; }
    if (!streaming) {
      const j = await r.json();
      return (j.choices?.[0]?.message?.content || '').trim();
    }
    // 流式：边生成边回调，首字一到前端就能看到
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let buf = '', full = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let p;
      while ((p = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, p).trim();
        buf = buf.slice(p + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j.choices?.[0]?.delta?.content || '';
          if (d) { full += d; onDelta(d, full); }
        } catch {}
      }
    }
    return full.trim();
  } catch (e) {
    console.error('[llm] error', e.message);
    return null;
  }
}

// ---------- 处理队列（串行） ----------
// 两段式翻译：第一遍短上下文快速出稿（首字快），900ms 后用完整上下文重译覆盖
const REFINE_DELAY_MS = 900;
function scheduleRefine(item) {
  setTimeout(async () => {
    try {
      if (!cfg.deepseekApiKey) return;
      const zh2 = await translateText(item.ko, 'ko2zh', null, { excludeId: item.id });
      if (!zh2) return;
      const s = zh2.trim();
      if (!s || /^<skip>$/i.test(s)) return;
      if (s === item.zh.trim()) return;
      item.zh = s;
      schedulePersist();
      broadcast({ type: 'revision', id: item.id, ko: item.ko, zh: s });
      console.log(`[${item.id}] 精修 => ${s}`);
    } catch (e) { console.error('[revise]', e.message); }
  }, REFINE_DELAY_MS);
}

async function drain() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const buf = queue.shift();
    const id = ++seq;
    const t0 = Date.now();
    const askMode = mode === 'ask';
    // 静音/环境噪音段直接丢弃（whisper 会在静音上幻觉出完整句子）
    const rms = wavRms(buf);
    if (rms < 0.008) { console.log(`[${id}] 丢弃(静音段 rms=${rms.toFixed(4)})`); continue; }
    let seg = { text: '', lang: '', avgLp: 0, nsp: 0 };
    try {
      seg = await transcribe(buf, askMode ? 'zh' : '');
    } catch (e) {
      console.error('[asr]', e.message);
    }
    const raw = cleanText(seg.text);
    lastAsrMs = Date.now() - t0;
    if (!raw) continue;
    // 只处理韩语/英语/中文，其他语言直接丢
    if (seg.lang && !ALLOWED_LANGS.has(seg.lang)) {
      console.log(`[${id}] 丢弃(非目标语言 ${seg.lang}) | ${raw.slice(0, 40)}`);
      continue;
    }
    // 低置信度 / 大概率静音噪音 → 丢
    if (seg.avgLp < -1.1 || seg.nsp > 0.45) {
      console.log(`[${id}] 丢弃(低置信 lp=${seg.avgLp.toFixed(2)} nsp=${seg.nsp.toFixed(2)}) | ${raw.slice(0, 40)}`);
      continue;
    }
    // 学生提问模式：中文 → 韩语（给老师看）
    if (askMode) {
      let ko = null;
      try {
        ko = await translateText(raw, 'zh2ko');
      } catch (e) {
        console.error('[llm]', e.message);
      }
      if (!ko || /^<skip>$/i.test(ko.trim()) || !ko.trim()) {
        console.log(`[${id}] 丢弃(${(ko || '').slice(0, 12)}) | ${raw.slice(0, 50)}`);
        continue;
      }
      const item = { id, zh: raw, ko, t: Date.now(), dir: 'zh2ko', via: 'voice' };
      talks.push(item);
      if (talks.length > 200) talks.shift();
      schedulePersist();
      broadcast({ type: 'talk', ...item, asrMs: lastAsrMs, totalMs: Date.now() - t0 });
      console.log(`[${id}] ask asr=${lastAsrMs}ms | ${raw}  =>  ${ko}`);
      continue;
    }
    // 识别到中文片段 → 课堂字幕不需要（中国学生看的就是中文），直接丢，不翻译也不显示
    if (seg.lang === 'chinese') {
      console.log(`[${id}] 丢弃(中文片段) | ${raw.slice(0, 40)}`);
      continue;
    }
    let zh = null;
    let partialSent = false;
    let lastPartialAt = 0;
    // 先把原文推给观众（显示"翻译中…"），中文流式到达后逐字替换
    broadcast({ type: 'partial', id, ko: raw, zh: '' });
    try {
      zh = await translateText(raw, 'ko2zh', (d, full) => {
        partialSent = true;
        const now = Date.now();
        if (now - lastPartialAt >= 100) { lastPartialAt = now; broadcast({ type: 'partial', id, ko: raw, zh: full }); }
      }, { fast: true });
    } catch (e) {
      console.error('[llm]', e.message);
    }
    // LLM 判定为噪音/幻觉/非课堂内容 → 撤回占位
    if (!zh || /^<skip>$/i.test(zh.trim()) || !zh.trim()) {
      if (partialSent) broadcast({ type: 'partial-cancel', id });
      console.log(`[${id}] 丢弃(${(zh || '').slice(0, 12)}) | ${raw.slice(0, 50)}`);
      continue;
    }
    const item = { id, ko: raw, zh, t: Date.now(), dir: 'ko2zh' };
    history.push(item);
    if (history.length > 200) history.shift();
    schedulePersist();
    broadcast({ type: 'subtitle', ...item, asrMs: lastAsrMs, totalMs: Date.now() - t0 });
    console.log(`[${id}] asr=${lastAsrMs}ms total=${Date.now() - t0}ms | ${raw}  =>  ${zh}`);
    if (cfg.refine !== false) scheduleRefine(item);
  }
  busy = false;
}

function enqueueAudio(buf) {
  if (!buf || buf.length < 44) return;
  queue.push(buf);
  if (queue.length > 20) queue.shift();
  drain();
}

const TRAD_RE = /[這個說麼請題學習們時會來對開關邊問電腦認證據實際發實現應該環裡為與沒誰給這]/;
async function toSimplified(s) {
  if (!cfg.deepseekApiKey || !TRAD_RE.test(s)) return s;
  try {
    const r = await fetch(cfg.llmBaseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.deepseekApiKey}` },
      body: JSON.stringify({
        model: cfg.llmModel,
        temperature: 0,
        max_tokens: 200,
        messages: [
          { role: 'system', content: '把用户给的中文转成简体字，只输出转换后的句子本身，不要解释、不要加引号。' },
          { role: 'user', content: s },
        ],
      }),
    });
    const j = await r.json();
    const t = (((j.choices || [])[0] || {}).message || {}).content || '';
    return t.trim() || s;
  } catch { return s; }
}

// 学生手机端语音：独立队列，中文转写 → 韩语 → 广播 talk
function enqueueStuAudio(buf, name, sid, cid) {
  if (!buf || buf.length < 44) return;
  if (!stuVoiceEnabled || !talkEnabled) return;
  stuQueue.push({ buf, name: String(name || '').slice(0, 20), sid: String(sid || '').slice(0, 20), cid: String(cid || '').slice(0, 24) });
  if (stuQueue.length > 12) stuQueue.shift();
  drainStu();
}

async function drainStu() {
  if (stuBusy) return;
  stuBusy = true;
  while (stuQueue.length) {
    const task = stuQueue.shift();
    const id = ++seq;
    const t0 = Date.now();
    try {
      const cid = task.cid;
      const skip = (why) => { console.log(`[${id}] stu-voice skip(${why}) | ${(task.name || '匿名')}`); broadcast({ type: 'stu-skip', cid, id }); };
      const rms = wavRms(task.buf);
      if (rms < 0.008) { skip('静音'); continue; }
      let seg = { text: '', lang: '', avgLp: 0, nsp: 0 };
      try { seg = await transcribe(task.buf, 'zh'); } catch (e) { console.error('[asr-stu]', e.message); }
      const raw = cleanText(seg.text);
      if (!raw) { skip('空'); continue; }
      if (seg.lang && !ALLOWED_LANGS.has(seg.lang)) { skip('语言' + seg.lang); continue; }
      if (seg.avgLp < -1.1 || seg.nsp > 0.45) { skip('低置信'); continue; }
      const isKo = /[\uAC00-\uD7A3]/.test(raw);
      let zh = isKo ? '' : await toSimplified(raw);
      let ko = null;
      if (isKo) {
        zh = (await translateText(raw, 'ko2zh', null, { fast: true })) || raw;
        ko = raw;
      } else {
        ko = await translateText(raw, 'zh2ko');
        if (!ko || /^<skip>$/i.test(ko.trim())) { console.log(`[${id}] stu-voice skip | ${raw.slice(0, 40)}`); skip('内容'); continue; }
      }
      const item = { id, zh, ko, t: Date.now(), dir: 'zh2ko', via: 'voice', from: task.name, sid: task.sid, cid: task.cid };
      talks.push(item);
      if (talks.length > 200) talks.shift();
      schedulePersist();
      broadcast({ type: 'talk', ...item, asrMs: Date.now() - t0, totalMs: Date.now() - t0 });
      console.log(`[${id}] stu-voice ${task.name || '匿名'}: ${zh} => ${ko}`);
    } catch (e) { console.error('[drainStu]', e.message); }
  }
  stuBusy = false;
}

// ---------- HTTP ----------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon',
};
function serveStatic(req, res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  if (p === '/api/info') {
    const ips = lanIPs();
    const base = ips[0] ? `http://${ips[0].address}:${cfg.port}` : `http://localhost:${cfg.port}`;
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      lanUrl: base,
      httpsUrl: (ips[0] && httpsServer) ? `https://${ips[0].address}:${HTTPS_PORT}` : '',
      publicUrl: cfg.publicUrl || '',
      viewUrl: `${base}/`, hostUrl: `${base}/host`, talkUrl: `${base}/talk`, adminUrl: `${base}/admin`, ips,
      port: cfg.port, model: path.basename(cfg.model), asrLang: cfg.asrLang,
      hasKey: !!cfg.deepseekApiKey, whisperReady,
      domain: cfg.domain || '', glossary: cfg.glossary || '', mode, talkEnabled, stuVoiceEnabled,
      host: hostState(),
      sessionStart: sessionStart.toISOString(), sessionFile: path.basename(sessionFile),
      history: history.slice(-50),
    }));
    return;
  }

  // 本课记录
  if (p === '/api/session' && req.method === 'GET') {
    const f = url.searchParams.get('file');
    if (f) {
      const safe = path.basename(f);
      try {
        const data = JSON.parse(fs.readFileSync(path.join(SESSION_DIR, safe), 'utf8'));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, file: safe, start: data.start, entries: data.entries || [] }));
      } catch { res.writeHead(404); res.end('{"ok":false}'); }
      return;
    }
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, start: sessionStart.toISOString(), file: path.basename(sessionFile), entries: sessionEntries() }));
    return;
  }
  if (p === '/api/sessions' && req.method === 'GET') {
    let list = [];
    try {
      list = fs.readdirSync(SESSION_DIR)
        .filter((n) => n.endsWith('.json'))
        .map((n) => {
          const fp = path.join(SESSION_DIR, n);
          let st = 0, count = 0;
          try { const d = JSON.parse(fs.readFileSync(fp, 'utf8')); st = new Date(d.start || 0).getTime(); count = (d.entries || []).length; } catch {}
          return { file: n, start: st, count, mtime: fs.statSync(fp).mtimeMs };
        })
        .sort((a, b) => b.mtime - a.mtime);
    } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, list }));
    return;
  }
  if (p === '/api/session' && req.method === 'DELETE') {
    const f = url.searchParams.get('file');
    if (!f) { res.writeHead(400); res.end('no file'); return; }
    try { fs.unlinkSync(path.join(SESSION_DIR, path.basename(f))); } catch {}
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  if (p === '/api/session/resume' && req.method === 'POST') {
    let body = '';
    for await (const c of req) body += c;
    let file = '';
    try { file = path.basename(String(JSON.parse(body || '{}').file || '')); } catch {}
    const fp = path.join(SESSION_DIR, file);
    if (!file || !fs.existsSync(fp)) {
      res.writeHead(404, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: 'not-found' }));
      return;
    }
    let data;
    try { data = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch { data = { entries: [] }; }
    persistNow(); // 先把当前课存好
    history.length = 0;
    talks.length = 0;
    chat.length = 0;
    seq = 0;
    chatSeq = 0;
    for (const e of (data.entries || [])) {
      const id = Number(e.id) || 0;
      if (e.kind === 'chat') {
        chat.push({ id, from: e.from, sid: e.sid, zh: e.zh, ko: e.ko, image: e.image || '', t: e.t, via: 'text' });
        chatSeq = Math.max(chatSeq, id);
      } else if (e.kind === 'talk') {
        talks.push({ ...e, id });
        seq = Math.max(seq, id);
      } else {
        history.push({ ...e, id });
        seq = Math.max(seq, id);
      }
    }
    sessionFile = fp;
    sessionStart = new Date(data.start || Date.now());
    const entries = sessionEntries().slice(-150);
    broadcast({ type: 'resumed', file, start: sessionStart.toISOString(), entries });
    console.log(`[session] 继续 ${file}（${(data.entries || []).length} 条，seq=${seq}）`);
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, file, start: sessionStart.toISOString(), count: (data.entries || []).length }));
    return;
  }
  if (p === '/api/session/new' && req.method === 'POST') {
    persistNow();
    sessionStart = new Date();
    sessionFile = path.join(SESSION_DIR, `课-${stamp(sessionStart)}.json`);
    history.length = 0;
    talks.length = 0;
    chat.length = 0;
    talkEnabled = false; // 每节新课默认关闭学生提问
    persistNow();
    broadcast({ type: 'clear' });
    broadcast({ type: 'talkState', enabled: false });
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, start: sessionStart.toISOString(), file: path.basename(sessionFile) }));
    return;
  }

  if (p === '/api/qr') {
    const data = url.searchParams.get('data') || 'http://localhost';
    try {
      const svg = await QRCode.toString(data, { type: 'svg', margin: 1, width: 320 });
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      res.end(svg);
    } catch { res.writeHead(500); res.end('qr error'); }
    return;
  }

  // 学生侧：中文 → 韩语（给老师看）
  if (p === '/api/talk' && req.method === 'POST') {
    if (!talkEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: 'disabled' }));
      return;
    }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', async () => {
      try {
        const text = String(JSON.parse(body || '{}').text || '').trim();
        if (!text) { res.writeHead(400); res.end('empty'); return; }
        const ko = await translateText(text, 'zh2ko');
        if (!ko || /^<skip>$/i.test(ko.trim())) {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
          res.end(JSON.stringify({ ok: false, reason: 'skip' }));
          return;
        }
        const msg = { type: 'talk', id: ++seq, zh: text, ko, t: Date.now(), via: 'text' };
        talks.push(msg);
        if (talks.length > 100) talks.shift();
        schedulePersist();
        broadcast(msg);
        console.log(`[talk] ${text}  =>  ${ko}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...msg }));
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // 课堂聊天室：中文↔韩语双向翻译，所有人可见（支持图片）
  if (p === '/api/chat' && req.method === 'POST') {
    if (!talkEnabled) {
      res.writeHead(403, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: false, reason: 'disabled' }));
      return;
    }
    let body = '';
    let tooBig = false;
    req.on('data', (c) => { if (tooBig) return; body += c; if (body.length > 6 * 1024 * 1024) { tooBig = true; req.destroy(); } });
    req.on('end', async () => {
      if (tooBig) return;
      try {
        const j = JSON.parse(body || '{}');
        const text = String(j.text || '').trim();
        if (text.length > 300) { res.writeHead(400); res.end('too long'); return; }
        const from = String(j.name || '').trim().slice(0, 20) || '匿名';
        const sid = String(j.sid || '').trim().slice(0, 20);
        let image = '';
        const raw = String(j.image || '');
        if (raw.startsWith('data:image/')) {
          const m = /^data:image\/(png|jpe?g|webp|gif);base64,(.+)$/i.exec(raw);
          if (m) {
            const ext = m[1].toLowerCase().replace('jpg', 'jpeg');
            const fn = `img-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
            fs.writeFileSync(path.join(UPLOAD_DIR, fn), Buffer.from(m[2], 'base64'));
            image = '/uploads/' + fn;
          }
        }
        if (!text && !image) { res.writeHead(400); res.end('empty'); return; }
        const isKo = /[\uAC00-\uD7A3\u1100-\u11FF\u3130-\u318F]/.test(text);
        const good = (s) => (s && !/^<skip>$/i.test(String(s).trim()) ? String(s).trim() : '');
        let zh = '';
        let ko = '';
        if (text) {
          if (isKo) {
            ko = text;
            zh = good(await translateText(text, 'ko2zh', null, { fast: true }));
          } else {
            zh = text;
            ko = good(await translateText(text, 'zh2ko'));
          }
        }
        const msg = { type: 'chat', id: ++chatSeq, from, sid, zh, ko, image, t: Date.now(), via: 'text' };
        chat.push(msg);
        if (chat.length > 300) chat.shift();
        schedulePersist();
        broadcast(msg);
        console.log(`[chat] ${from} ${isKo ? 'ko→zh' : 'zh→ko'} | ${text.slice(0, 40) || '(图片)'} => ${String(ko || zh).slice(0, 40)}`);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, ...msg }));
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }
  if (p === '/api/chat' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ ok: true, messages: chat.slice(-100) }));
    return;
  }

  // 翻译服务配置（API key / 接口地址 / 模型）—— 别人部署时填自己的 key
  if (p === '/api/config' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({
      ok: true,
      hasKey: !!cfg.deepseekApiKey,
      keyTail: cfg.deepseekApiKey ? cfg.deepseekApiKey.slice(-4) : '',
      llmBaseUrl: cfg.llmBaseUrl,
      llmModel: cfg.llmModel,
    }));
    return;
  }
  if (p === '/api/config' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 20000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        if (j.clearKey === true) cfg.deepseekApiKey = '';
        else if (typeof j.deepseekApiKey === 'string' && j.deepseekApiKey.trim()) cfg.deepseekApiKey = j.deepseekApiKey.trim();
        if (typeof j.llmBaseUrl === 'string' && j.llmBaseUrl.trim()) cfg.llmBaseUrl = j.llmBaseUrl.trim();
        if (typeof j.llmModel === 'string' && j.llmModel.trim()) cfg.llmModel = j.llmModel.trim();
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2));
        broadcast({ type: 'configState', hasKey: !!cfg.deepseekApiKey });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, hasKey: !!cfg.deepseekApiKey }));
        console.log(`[config] 翻译服务已更新：key ${cfg.deepseekApiKey ? '已设置' : '未设置'}，模型 ${cfg.llmModel}`);
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // 课程领域 / 术语对照（提升翻译准确率）
  if (p === '/api/glossary' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 100000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        if (typeof j.domain === 'string') cfg.domain = j.domain.slice(0, 200);
        if (typeof j.glossary === 'string') cfg.glossary = j.glossary.slice(0, 20000);
        fs.writeFileSync(path.join(ROOT, 'config.json'), JSON.stringify(cfg, null, 2));
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, domain: cfg.domain, glossaryLen: cfg.glossary.length }));
        console.log(`[glossary] 已更新：领域=${cfg.domain || '(空)'} 术语 ${cfg.glossary.length} 字`);
      } catch {
        res.writeHead(400); res.end('bad request');
      }
    });
    return;
  }

  // 远程控制录音端（老师电脑）：开始/停止收音
  if (p === '/api/host-control' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        const cmd = j.cmd === 'stop' ? 'stop' : 'start';
        let sent = 0;
        for (const ws of wssHost.clients) {
          if (ws.readyState === 1) { ws.send(JSON.stringify({ type: 'hostCmd', cmd })); sent++; }
        }
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: sent > 0, sent }));
        console.log(`[host] 远程命令 ${cmd}，已送达 ${sent} 个录音端`);
      } catch { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }

  // 主机模式切换：lecture（老师讲课 韩/英→中） / ask（学生提问 中→韩）
  if (p === '/api/mode' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        mode = j.mode === 'ask' ? 'ask' : 'lecture';
        broadcast({ type: 'mode', mode });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, mode }));
        console.log(`[mode] 切换到 ${mode}`);
      } catch { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }

  // 学生提问页面开关（/talk 是否可用）
  if (p === '/api/talk-toggle' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        talkEnabled = !!j.enabled;
        broadcast({ type: 'talkState', enabled: talkEnabled });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, talkEnabled }));
        console.log(`[talk] 学生提问 ${talkEnabled ? '已开放' : '已关闭'}`);
      } catch { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }

  // 学生语音提问开关
  if (p === '/api/stu-voice' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2000) req.destroy(); });
    req.on('end', () => {
      try {
        const j = JSON.parse(body || '{}');
        stuVoiceEnabled = !!j.enabled;
        broadcast({ type: 'stuVoice', enabled: stuVoiceEnabled });
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ ok: true, stuVoiceEnabled }));
        console.log(`[stu-voice] 学生语音 ${stuVoiceEnabled ? '已开放' : '已关闭'}`);
      } catch { res.writeHead(400); res.end('bad request'); }
    });
    return;
  }

  if (p.startsWith('/uploads/') && req.method === 'GET') {
    return serveStatic(req, res, path.join(UPLOAD_DIR, path.basename(p)));
  }
  if (p === '/' || p === '/view') return serveStatic(req, res, path.join(PUBLIC, 'index.html'));
  if (p === '/host') return serveStatic(req, res, path.join(PUBLIC, 'host.html'));
  if (p === '/talk') return serveStatic(req, res, path.join(PUBLIC, 'talk.html'));
  if (p === '/admin') return serveStatic(req, res, path.join(PUBLIC, 'admin.html'));

  const safe = path.normalize(p).replace(/^([/\\])+/, '');
  const target = path.join(PUBLIC, safe);
  if (target.startsWith(PUBLIC) && fs.existsSync(target) && fs.statSync(target).isFile()) {
    return serveStatic(req, res, target);
  }
  res.writeHead(404); res.end('not found');
});

// ---------- WebSocket ----------
const wssHost = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });
const wssView = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
const wssStu = new WebSocketServer({ noServer: true, maxPayload: 8 * 1024 * 1024 });

for (const wss of [wssHost, wssView, wssStu]) {
  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('error', () => {});
  });
}
setInterval(() => {
  for (const wss of [wssHost, wssView, wssStu]) {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }
}, 30000).unref();

wssView.on('connection', (ws) => {
  viewers.add(ws);
  const ips = lanIPs();
  ws.send(JSON.stringify({
    type: 'init',
    lanUrl: ips[0] ? `http://${ips[0].address}:${cfg.port}` : '',
    hasKey: !!cfg.deepseekApiKey,
    history: history.slice(-30),
    chat: chat.slice(-80),
    entries: sessionEntries().slice(-150),
    sessionFile: path.basename(sessionFile),
    host: hostState(),
  }));
  ws.on('close', () => viewers.delete(ws));
  console.log(`[view] +1 (${viewers.size})`);
});

wssHost.on('connection', (ws) => {
  hostConns++;
  console.log(`[host] connected (${hostConns})`);
  broadcastHostState();
  ws.send(JSON.stringify({ type: 'hello', hasKey: !!cfg.deepseekApiKey, model: path.basename(cfg.model), whisperReady }));
  ws.on('message', (data, isBinary) => {
    if (isBinary) { lastAudioAt = Date.now(); enqueueAudio(Buffer.from(data)); }
    else {
      try {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'ping') ws.send(JSON.stringify({ type: 'pong', t: Date.now() }));
        if (msg.type === 'level') { lastLevelAt = Date.now(); broadcast({ type: 'hostLevel', v: Number(msg.v) || 0, t: Date.now() }); }
        if (msg.type === 'recState') {
          const on = !!msg.running;
          hostRecording = on;
          lastLevelAt = on ? Date.now() : 0;
          broadcastHostState();
        }
      } catch {}
    }
  });
  ws.on('close', () => {
    hostConns = Math.max(0, hostConns - 1);
    if (hostConns === 0) hostRecording = false;
    console.log(`[host] disconnected (${hostConns})`);
    broadcastHostState();
  });
});

wssStu.on('connection', (ws, req) => {
  const u = new URL(req.url, 'http://x');
  const name = String(u.searchParams.get('name') || '').slice(0, 20);
  const sid = String(u.searchParams.get('sid') || '').slice(0, 20);
  const cid = String(u.searchParams.get('cid') || '').slice(0, 24);
  console.log(`[stu] ${name || '匿名'}${sid ? '(' + sid + ')' : ''} connected`);
  ws.send(JSON.stringify({ type: 'hello', enabled: stuVoiceEnabled }));
  ws.on('message', (data, isBinary) => {
    if (!isBinary) return;
    if (!stuVoiceEnabled) {
      try { ws.send(JSON.stringify({ type: 'disabled' })); } catch {}
      return;
    }
    enqueueStuAudio(Buffer.from(data), name, sid, cid);
  });
  ws.on('close', () => console.log(`[stu] ${name || '匿名'} disconnected`));
  ws.on('error', () => {});
});

// ---------- HTTPS（学生用手机录音必须安全上下文） ----------
const CERT_DIR = path.join(ROOT, 'certs');
let httpsServer = null;
try {
  const certFile = path.join(CERT_DIR, 'cert.pem');
  const keyFile = path.join(CERT_DIR, 'key.pem');
  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    httpsServer = https.createServer(
      { key: fs.readFileSync(keyFile), cert: fs.readFileSync(certFile) },
      server.listeners('request')[0]
    );
    console.log('[https] 证书已加载');
  }
} catch (e) { console.warn('[https] 证书加载失败:', e.message); }
const HTTPS_PORT = cfg.httpsPort || 8443;

function onUpgrade(req, socket, head) {
  const { pathname } = new URL(req.url, 'http://x');
  if (pathname === '/ws/host') wssHost.handleUpgrade(req, socket, head, (ws) => wssHost.emit('connection', ws, req));
  else if (pathname === '/ws/view') wssView.handleUpgrade(req, socket, head, (ws) => wssView.emit('connection', ws, req));
  else if (pathname === '/ws/stu') wssStu.handleUpgrade(req, socket, head, (ws) => wssStu.emit('connection', ws, req));
  else socket.destroy();
}
server.on('upgrade', onUpgrade);
if (httpsServer) httpsServer.on('upgrade', onUpgrade);

// ---------- 启动 ----------
let shuttingDown = false;
function shutdown() {
  shuttingDown = true;
  if (whisperProc) { try { whisperProc.kill(); } catch {} }
  try { httpsServer && httpsServer.close(); } catch {}
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

console.log('[boot] 启动 whisper-server …');
startWhisperServer();

const ready = await waitWhisperReady();
whisperReady = ready;
if (!ready) {
  console.error('[fatal] whisper-server 未就绪，请检查模型/ffmpeg');
  process.exit(1);
}

server.listen(cfg.port, cfg.host, () => {
  const ips = lanIPs();
  console.log('==========================================');
  console.log('  课堂同传已启动');
  console.log(`  主机（你）: http://localhost:${cfg.port}/host`);
  for (const ip of ips) console.log(`  学生扫码  : http://${ip.address}:${cfg.port}/`);
  if (httpsServer) {
    for (const ip of ips) console.log(`  学生录音  : https://${ip.address}:${HTTPS_PORT}/  （首次需点“继续前往”）`);
  }
  console.log(`  模型      : ${path.basename(cfg.model)}  语言: ${cfg.asrLang}  线程: ${cfg.threads}`);
  console.log(`  翻译      : ${cfg.deepseekApiKey ? 'DeepSeek 已配置' : '未配置 key（只显示韩语原文）'}`);
  console.log('==========================================');
});
if (httpsServer) {
  httpsServer.listen(HTTPS_PORT, cfg.host, () => console.log(`[https] 监听 ${HTTPS_PORT}`));
}
