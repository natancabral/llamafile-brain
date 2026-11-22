'use strict';

const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { waitHealthy } = require('./client');
const { t: tr } = require('../shared/i18n');

/** Splits "a b 'c d'" into args (simple quote support). */
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str || ''))) out.push(m[1] ?? m[2] ?? m[3]);
  return out;
}

/**
 * GPU flags: 'on' = all layers on the GPU (-ngl 999), 'off' = CPU only (-ngl 0), 'auto' = leave it alone
 * (llamafile decides). If -ngl/--n-gpu-layers/--gpu is already in the extra arguments, those win.
 */
function gpuFlags(gpu, extra) {
  if (gpu !== 'on' && gpu !== 'off') return [];
  if (extra.some((a) => a === '-ngl' || a === '--n-gpu-layers' || a === '--gpu' || a.startsWith('--n-gpu-layers='))) return [];
  return ['-ngl', gpu === 'on' ? '999' : '0'];
}

/** Resolves true if nothing is listening on host:port. */
function portFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, host);
  });
}

/** Kills the process and its children (llamafile is started through /bin/sh, so killing only sh leaves it running). */
function killTree(proc) {
  if (!proc || proc.exitCode !== null || !proc.pid) return;
  try {
    if (process.platform === 'win32') spawn('taskkill', ['/pid', String(proc.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true });
    else process.kill(-proc.pid, 'SIGTERM');
  } catch {
    try {
      proc.kill();
    } catch {
      /* already gone */
    }
  }
}

// ---- spawned-server registry: lets the next launch clean up servers left behind by a crash or `kill -9`
let stateFile = null;
const live = new Map(); // server name -> { pid, file }
const saveLive = () => {
  if (!stateFile) return;
  try {
    fs.writeFileSync(stateFile, JSON.stringify([...live.values()]));
  } catch {
    /* not critical */
  }
};
/** Where to keep the registry (the app's data folder). */
function setStateDir(dir) {
  stateFile = path.join(dir, 'servers.json');
}
/** Kills llamafile servers recorded by a previous run that are still alive (matched by process group + file name, so a reused pid is never touched). */
function reapOrphans() {
  if (!stateFile || process.platform === 'win32') return 0;
  let list = [];
  try {
    list = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  } catch {
    return 0;
  }
  let n = 0;
  for (const { pid, file } of list) {
    if (!pid || !file) continue;
    const r = spawnSync('pgrep', ['-g', String(pid), '-f', file], { stdio: 'ignore' });
    if (r.status !== 0) continue;
    try {
      process.kill(-pid, 'SIGTERM');
      n++;
    } catch {
      /* already gone */
    }
  }
  try {
    fs.unlinkSync(stateFile);
  } catch {
    /* ignore */
  }
  return n;
}

/**
 * Manages one llamafile server process.
 * On macOS/Linux the file is launched through /bin/sh (APE binaries need it on some systems).
 * On Windows the file must end in .exe (and be < 4 GB; otherwise use the llamafile binary + external GGUF via args).
 */
class LlamafileServer {
  constructor({ name, onLog, onStatus }) {
    this.name = name;
    this.onLog = onLog || (() => {});
    this.onStatus = onStatus || (() => {});
    this.proc = null;
    this._status = 'stopped';
  }

  /** stopped | starting | running | error. Every change is reported, so the UI never misses one (crash, stop, ready...). */
  get status() {
    return this._status;
  }
  set status(v) {
    if (v === this._status) return;
    this._status = v;
    this.onStatus(v);
  }

  /** Idempotent: a second call while starting waits for the first one instead of doing nothing. */
  start(opts) {
    if (this.starting) return this.starting;
    if (this.proc) return Promise.resolve();
    // Mark "starting" right away (the UI is told before the first await below), otherwise it would
    // briefly read "stopped" with the Start button enabled while the model is still loading.
    this.status = 'starting';
    this.starting = this._start(opts)
      .catch((e) => {
        if (this.status === 'starting') this.status = 'error'; // failed before spawning (no file, busy port...)
        throw e;
      })
      .finally(() => {
        this.starting = null;
      });
    return this.starting;
  }

  async _start({ file, port, args = '', host = '127.0.0.1', embedding = false, gpu = 'auto' }) {
    if (!file || !fs.existsSync(file)) throw new Error(tr('srv.noFile', { file: file || tr('srv.empty') }));

    if (!(await portFree(port, host))) {
      throw new Error(tr('srv.portBusy', { port }));
    }
    const extra = splitArgs(args);
    const flags = [];
    if (embedding && !extra.includes('--embedding')) flags.push('--embedding');
    // Embeddings precisam de pooling; sem isso o servidor recusa /v1/embeddings ("Pooling type 'none'").
    if (embedding && !extra.some((a) => a === '--pooling' || a.startsWith('--pooling='))) flags.push('--pooling', 'mean');
    flags.push(...gpuFlags(gpu, extra));
    const full = ['--server', '--host', host, '--port', String(port), ...flags, ...extra];
    const isWin = process.platform === 'win32';
    if (!isWin) {
      try {
        fs.chmodSync(file, 0o755);
      } catch {
        /* ignore */
      }
    }
    if (isWin && !/\.exe$/i.test(file)) throw new Error(tr('srv.needExe', { file }));
    const cmd = isWin ? file : '/bin/sh';
    const cmdArgs = isWin ? full : [file, ...full];

    this.status = 'starting';
    this.onLog(this.name, `$ ${cmd} ${cmdArgs.join(' ')}`);
    const proc = spawn(cmd, cmdArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: !isWin });
    this.proc = proc;
    live.set(this.name, { pid: proc.pid, file });
    saveLive();

    const tail = [];
    const log = (d) => {
      const t = d.toString();
      this.onLog(this.name, t);
      tail.push(...t.split('\n').filter((l) => l.trim()));
      if (tail.length > 12) tail.splice(0, tail.length - 12);
    };
    proc.stdout.on('data', log);
    proc.stderr.on('data', log);
    // Fail fast: if the process dies before becoming healthy, report it right away (with the log tail) instead of waiting minutes.
    const died = new Promise((_, reject) => {
      proc.on('error', (e) => {
        this.status = 'error';
        this.onLog(this.name, tr('srv.startError', { e: e.message }));
        this.proc = null;
        reject(new Error(tr('srv.execFail', { e: e.message })));
      });
      proc.on('exit', (code) => {
        this.onLog(this.name, tr('srv.exited', { code }));
        const wasStarting = this.status === 'starting';
        if (this.status !== 'stopped') this.status = code === 0 ? 'stopped' : 'error';
        if (this.proc === proc) this.proc = null;
        live.delete(this.name);
        saveLive();
        if (wasStarting) {
          reject(new Error(tr('srv.closed', { name: this.name, code, tail: tail.slice(-8).join('\n') })));
        }
      });
    });
    died.catch(() => {});

    const stopWaiting = new AbortController();
    try {
      const healthy = waitHealthy(`http://${host}:${port}`, { timeoutMs: 300000, signal: stopWaiting.signal });
      healthy.catch(() => {}); // cancelado abaixo quando o processo morre
      await Promise.race([healthy, died]);
      this.status = 'running';
    } catch (e) {
      stopWaiting.abort();
      killTree(proc);
      this.proc = null;
      this.status = 'error';
      throw e;
    }
  }

  stop() {
    this.status = 'stopped';
    if (this.proc) {
      killTree(this.proc);
      this.proc = null;
    }
    live.delete(this.name);
    saveLive();
  }
}

module.exports = { LlamafileServer, splitArgs, portFree, gpuFlags, setStateDir, reapOrphans };
