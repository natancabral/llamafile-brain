'use strict';

/**
 * Machine information for the chat ("how much RAM do I have?", "what is my GPU?"), pure Node:
 * no Python/Go needed. Works on Linux, macOS and Windows. Every native command is a fixed
 * program with fixed arguments (never built from user text, never through a shell) and any
 * failure just leaves that field empty.
 */

const os = require('node:os');
const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { t: tr } = require('../shared/i18n');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

function run(cmd, args, timeout = 6000) {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout, windowsHide: true, maxBuffer: 2 * 1024 * 1024 }, (err, stdout) => resolve(err ? '' : String(stdout)));
    } catch {
      resolve('');
    }
  });
}
const ps = (script) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script]);
/** Parses `wmic ... /value` output (KEY=VALUE lines, records separated by blank lines) into [{KEY: VALUE}]. */
function parseWmic(text) {
  const recs = [];
  let cur = {};
  for (const raw of String(text).replace(/\0/g, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) {
      if (Object.keys(cur).length) recs.push(cur);
      cur = {};
      continue;
    }
    const i = line.indexOf('=');
    if (i > 0) cur[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  if (Object.keys(cur).length) recs.push(cur);
  return recs;
}
// Windows plan B when PowerShell is blocked or missing (wmic exists on Windows 7 to 11 23H2; removed from some newer builds).
const wmic = async (args) => (isWin ? parseWmic(await run('wmic', [...args, '/value'])) : []);

const readFile = (p) => {
  try {
    return fs.readFileSync(p, 'utf8').trim();
  } catch {
    return '';
  }
};
const parseJson = (s) => {
  try {
    const v = JSON.parse(s);
    return Array.isArray(v) ? v : v ? [v] : [];
  } catch {
    return [];
  }
};

/** RAM that can really be used by a new program. os.freemem() ignores reclaimable cache on Linux/macOS. */
async function availableMemory() {
  try {
    if (process.platform === 'linux') {
      const m = /MemAvailable:\s+(\d+)\s+kB/.exec(readFile('/proc/meminfo'));
      if (m) return Number(m[1]) * 1024;
    } else if (isMac) {
      const out = await run('vm_stat', []);
      const page = Number((/page size of (\d+) bytes/.exec(out) || [])[1]) || 4096;
      const pick = (label) => Number((new RegExp(`${label}:\\s+(\\d+)`).exec(out) || [])[1]) || 0;
      const pages = pick('Pages free') + pick('Pages inactive') + pick('Pages speculative') + pick('Pages purgeable');
      if (pages) return Math.min(pages * page, os.totalmem());
    }
  } catch {
    /* fall through */
  }
  return os.freemem(); // Windows: already "available"
}

async function computerModel() {
  if (isMac) {
    const out = await run('system_profiler', ['SPHardwareDataType']);
    const name = /Model Name:\s*(.+)/.exec(out)?.[1]?.trim();
    const id = /Model Identifier:\s*(.+)/.exec(out)?.[1]?.trim();
    return [name, id && `(${id})`].filter(Boolean).join(' ');
  }
  if (isWin) {
    const [r] = parseJson(await ps('Get-CimInstance Win32_ComputerSystem | Select-Object Manufacturer,Model | ConvertTo-Json -Compress'));
    if (r) return [r.Manufacturer, r.Model].filter(Boolean).join(' ');
    const [w] = await wmic(['computersystem', 'get', 'Manufacturer,Model']);
    return w ? [w.Manufacturer, w.Model].filter(Boolean).join(' ') : '';
  }
  const d = '/sys/devices/virtual/dmi/id/';
  const v = [readFile(`${d}sys_vendor`), readFile(`${d}product_name`)].filter(Boolean).join(' ');
  return v || readFile('/proc/device-tree/model').replace(/\0/g, ''); // Raspberry Pi and other ARM boards
}

async function gpuList() {
  if (isMac) {
    const out = await run('system_profiler', ['SPDisplaysDataType']);
    return [...out.matchAll(/Chipset Model:\s*(.+)/g)].map((m) => m[1].trim());
  }
  if (isWin) {
    const rows = parseJson(await ps('Get-CimInstance Win32_VideoController | Select-Object Name,AdapterRAM | ConvertTo-Json -Compress'));
    if (rows.length) return rows.map((r) => r.Name).filter(Boolean);
    return (await wmic(['path', 'win32_videocontroller', 'get', 'Name'])).map((r) => r.Name).filter(Boolean);
  }
  const nv = (await run('nvidia-smi', ['--query-gpu=name,memory.total', '--format=csv,noheader'])).trim();
  if (nv) return nv.split('\n').map((l) => l.trim()).filter(Boolean);
  const out = await run('lspci', []);
  return out
    .split('\n')
    .filter((l) => /VGA compatible|3D controller|Display controller/i.test(l))
    .map((l) => l.replace(/^\S+\s+[^:]+:\s*/, '').trim());
}

/** Mounted local volumes: [{ name, mount, total, free }] (bytes). df on macOS/Linux, Win32_LogicalDisk on Windows. */
async function diskList() {
  if (isWin) {
    const rows = parseJson(await ps('Get-CimInstance Win32_LogicalDisk | Where-Object { $_.DriveType -eq 3 } | Select-Object DeviceID,VolumeName,Size,FreeSpace | ConvertTo-Json -Compress'));
    const fromWmic = rows.length ? [] : (await wmic(['logicaldisk', 'where', 'drivetype=3', 'get', 'DeviceID,VolumeName,Size,FreeSpace']));
    return (rows.length ? rows : fromWmic).map((r) => ({ name: r.VolumeName || r.DeviceID, mount: r.DeviceID, total: Number(r.Size) || 0, free: Number(r.FreeSpace) || 0 }));
  }
  const out = await run('df', ['-kP']);
  const seen = new Map();
  const list = [];
  for (const line of out.split('\n').slice(1)) {
    const m = /^(\S+)\s+(\d+)\s+(\d+)\s+(\d+)\s+\d+%\s+(.+)$/.exec(line.trim());
    if (!m || !m[1].startsWith('/dev/') || /\/dev\/loop/.test(m[1])) continue;
    const mount = m[5];
    if (/^\/System\/Volumes\/(VM|Preboot|Update|xarts|iSCPreboot|Hardware|Recovery)|^\/boot\/efi|^\/snap\/|^\/Library\/Developer\/CoreSimulator|^\/Volumes\/Recovery/.test(mount)) continue;
    // macOS exposes one APFS container as several mounts with the same numbers: keep one ("/System/Volumes/Data" wins over "/")
    const key = `${m[2]}:${m[4]}`;
    const row = { name: m[1], mount, total: Number(m[2]) * 1024, free: Number(m[4]) * 1024 };
    const at = seen.get(key);
    if (at === undefined) {
      seen.set(key, list.length);
      list.push(row);
    } else if (mount === '/System/Volumes/Data') list[at] = row;
  }
  return list;
}

/** Network interfaces that are up and not loopback: [{ name, mac, addrs: ['192.168...'] }]. */
function netList() {
  const out = [];
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    if (/^(utun|awdl|llw|anpi|ap|bridge|gif|stf|veth|docker|br-|virbr|vmnet|vboxnet|vEthernet)/i.test(name)) continue; // virtual / tunnel interfaces
    const ext = (list || []).filter((i) => !i.internal);
    if (!ext.length) continue;
    out.push({ name, mac: ext[0].mac && ext[0].mac !== '00:00:00:00:00:00' ? ext[0].mac : '', addrs: ext.map((i) => i.address) });
  }
  return out;
}

const ALL_TOPICS = new Set(['ram', 'host', 'model', 'gpu', 'cpu', 'os', 'disk', 'net', 'mac']);
let cached = { gpus: [], model: '' }; // slow lookups, filled once by primeSysInfo() so the chat prompt can use them instantly

/** Collects only the requested topics (a Set of: ram, host, model, gpu, mac, cpu, os). */
async function getSysInfo(topics = ALL_TOPICS) {
  const want = (k) => topics.has(k);
  const cpus = os.cpus() || [];
  const [free, model, gpus, disks] = await Promise.all([
    want('ram') ? availableMemory() : 0,
    want('model') ? computerModel() : '',
    want('gpu') ? gpuList() : [],
    want('disk') ? diskList() : [],
  ]);
  return {
    host: os.hostname(),
    user: (() => {
      try {
        return os.userInfo().username;
      } catch {
        return '';
      }
    })(),
    os: `${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform} ${os.release()} (${os.arch()})`,
    cpu: cpus[0] ? { name: cpus[0].model.replace(/\s+/g, ' ').trim(), threads: cpus.length, mhz: cpus[0].speed || 0 } : null,
    arch: os.arch(),
    kernel: os.release(),
    uptime: os.uptime(),
    disks,
    nets: want('net') || want('mac') ? netList() : [],
    ramTotal: os.totalmem(),
    ramFree: free,
    model,
    gpus,
  };
}

/** Warms the slow lookups (computer model, GPU) in the background; call once at startup. */
async function primeSysInfo() {
  try {
    const i = await getSysInfo(new Set(['model', 'gpu']));
    cached = { gpus: i.gpus, model: i.model };
  } catch {
    /* keep empty */
  }
}

/** Short block for the chat's system prompt: the model really knows what machine it runs on. No MAC/IPs. */
function systemContextBlock() {
  const cpus = os.cpus() || [];
  const gb1 = (b) => (b / 1073741824).toFixed(1);
  const lines = [
    `Computer name: ${os.hostname()}`,
    cached.model && `Computer model: ${cached.model}`,
    `System: ${{ darwin: 'macOS', win32: 'Windows', linux: 'Linux' }[process.platform] || process.platform} ${os.release()} (${os.arch()})`,
    cpus[0] && `Processor: ${cpus[0].model.replace(/\s+/g, ' ').trim()} (${cpus.length} threads)`,
    `RAM: ${gb1(os.totalmem())} GB total`,
    cached.gpus.length && `Graphics: ${cached.gpus.join('; ')}`,
  ].filter(Boolean);
  return `Facts about the computer the user is running this app on (collected by the app, real data). You CAN answer questions about this computer from them; never say you have no access to the machine. For other details (disks, network, MAC) tell the user to open Settings → Computer, or ask "what is my MAC address?".\n${lines.map((l) => `- ${l}`).join('\n')}`;
}

// ---------------------------------------------------------------- intent (en / pt / es, code-driven like the memory commands)
const strip = (s) => String(s).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const MACHINE = '(?:pc|computador|computadora|ordenador|maquina|notebook|laptop|computer|machine|mac|meu|minha|mi|my)';
const TOPIC_RE = {
  ram: new RegExp(`\\b(?:ram|memoria\\s+ram|memoria\\s+(?:do|de\\s+mi|de\\s+la)\\s+${MACHINE}|quanta\\s+memoria|how\\s+much\\s+(?:ram|memory)|cuanta\\s+memoria|memory\\s+(?:do\\s+i|i)\\s+have|(?:minha|mi|my)\\s+memor(?:ia|y))\\b`),
  host: /\b(?:nome\s+(?:do|da)\s+(?:meu\s+|minha\s+)?(?:pc|computador|maquina|notebook)|hostname|nombre\s+(?:de|del)\s+(?:mi\s+)?(?:pc|computadora|ordenador|maquina)|(?:pc|computer|machine|host)\s+name|name\s+of\s+(?:my\s+)?(?:pc|computer|machine))\b/,
  model: /\b(?:modelo\s+(?:do|da|de)\s+(?:meu\s+|minha\s+|mi\s+)?(?:pc|computador|computadora|ordenador|maquina|notebook|mac|laptop)|(?:pc|computer|laptop|machine|mac)\s+model|model\s+of\s+(?:my\s+)?(?:pc|computer|laptop|machine|mac))\b/,
  gpu: /\b(?:gpu|placa\s+de\s+video|placa\s+grafica|tarjeta\s+(?:de\s+video|grafica)|video\s+card|graphics\s+card|(?:minha|mi|my)\s+(?:placa\s+de\s+video|gpu))\b/,
  mac: /\b(?:mac\s+address|endereco\s+mac|direccion\s+mac|mac\b.*\b(?:address|endereco|direccion)|(?:endereco|direccion)\s+(?:do\s+)?mac)\b/,
  cpu: /\b(?:processador|procesador|cpu|processor)\b/,
  disk: /\b(?:disco|hd|ssd|armazenamento|almacenamiento|storage|disk|espaco\s+em\s+disco)\b/,
  net: /\b(?:rede|network|wifi|wi-fi|red\s+local|ip\s+local|endereco\s+ip|ip\s+address|direccion\s+ip)\b/,
  os: /\b(?:sistema\s+operacional|sistema\s+operativo|operating\s+system|versao\s+do\s+(?:sistema|windows|macos|linux))\b/,
  all: new RegExp(`\\b(?:(?:informacoes|informacao|informaciones|informacion|info|specs?|especificacoes|especificaciones|configuracao|configuracoes|hardware)\\s+(?:do|da|de|of|about)?\\s*(?:meu\\s+|minha\\s+|mi\\s+|my\\s+|the\\s+)?${MACHINE}|(?:system|machine|computer|pc)\\s+(?:info|information|specs)|my\\s+(?:pc|computer)\\s+specs)\\b`),
};

/** Returns a Set of topics when the question is asking about THIS machine, else null. Needs a question-ish phrasing for the weak words. */
function parseSysInfoIntent(question) {
  const s = strip(question).trim();
  if (!s || s.length > 200) return null;
  const topics = new Set();
  for (const [k, re] of Object.entries(TOPIC_RE)) if (re.test(s)) topics.add(k);
  // ram / cpu / gpu are common words in general questions ("what is a GPU?"): they need a first-person / "this machine" cue
  const personal = /\b(?:meu|minha|meus|minhas|mi|mis|my|este|esta|esse|essa|this|desse|dessa|do\s+pc|do\s+computador|aqui|here|tenho|tengo|have|uso|using|tem|tiene)\b/.test(s);
  if (topics.has('all')) {
    ['ram', 'host', 'model', 'gpu', 'cpu', 'os'].forEach((k) => topics.add(k));
    topics.delete('all');
    return topics;
  }
  const weak = ['ram', 'cpu', 'gpu', 'disk', 'net'];
  if (!personal) weak.forEach((k) => topics.delete(k));
  // "qual meu pc / minha máquina, fale das especificações": no single topic, but clearly asking about this machine
  if (!topics.size) {
    const poss = /\b(?:meu|minha|my|mi)\s+(?:\w+\s+)?(?:pc|computador|maquina|notebook|laptop|mac|computer|machine|ordenador|computadora|equipo)\b/.test(s);
    const cue = /\b(?:especifica\w*|specs?|hardware|configura\w*|informac\w*|info|qual|quais|what|which|fale|diga|mostre|mostra|descreva|show|tell|describe|cual|cuales|dime|muestra|detalh\w*)\b/.test(s);
    if (poss && cue) return new Set(['ram', 'host', 'model', 'gpu', 'cpu', 'os', 'disk']);
  }
  return topics.size ? topics : null;
}

const gb = (b) => (b / 1073741824).toFixed(1);

/** Formats the answer (UI language) for the requested topics. */
async function answerSysInfo(topics) {
  const i = await getSysInfo(topics);
  const lines = [];
  if (topics.has('host')) lines.push(tr('sys.host', { v: i.host }));
  if (topics.has('model')) lines.push(tr('sys.model', { v: i.model || tr('sys.unknown') }));
  if (topics.has('os')) lines.push(tr('sys.os', { v: i.os }));
  if (topics.has('cpu') && i.cpu) lines.push(tr('sys.cpu', { v: i.cpu.name, n: i.cpu.threads }));
  if (topics.has('ram')) lines.push(tr('sys.ram', { total: gb(i.ramTotal), free: gb(i.ramFree) }));
  if (topics.has('gpu')) lines.push(tr('sys.gpu', { v: i.gpus.length ? i.gpus.join('; ') : tr('sys.unknown') }));
  if (topics.has('disk')) {
    lines.push(tr('sys.disk', { v: i.disks.length ? i.disks.map((d) => `${d.mount}: ${gb(d.free)}/${gb(d.total)} GB`).join('; ') : tr('sys.unknown') }));
  }
  if (topics.has('net')) {
    lines.push(tr('sys.net', { v: i.nets.length ? i.nets.map((n) => `${n.name}: ${n.addrs.join(', ')}`).join('; ') : tr('sys.unknown') }));
  }
  if (topics.has('mac')) {
    const macs = i.nets.filter((n) => n.mac);
    lines.push(tr('sys.mac', { v: macs.length ? macs.map((m) => `${m.name}: \`${m.mac}\``).join('; ') : tr('sys.unknown') }));
  }
  return lines.join('\n');
}

module.exports = { parseWmic, primeSysInfo, systemContextBlock, ALL_TOPICS, getSysInfo, availableMemory, parseSysInfoIntent, answerSysInfo };
