// Watches which programs are running, using one long-lived PowerShell loop instead of spawning a process every tick.
const { spawn } = require('child_process');
const { EventEmitter } = require('events');

const SCRIPT = (sec) => `$ErrorActionPreference='SilentlyContinue'; [Console]::OutputEncoding=[Text.Encoding]::UTF8
while ($true) { $p = @(Get-Process | Where-Object Path | ForEach-Object Path | Sort-Object -Unique); [Console]::Out.WriteLine('@@' + ($p -join '|')); [Console]::Out.Flush(); Start-Sleep -Seconds ${sec} }`;

class Tracker extends EventEmitter {
  constructor(intervalSec = 10) { super(); this.intervalSec = intervalSec; this.proc = null; this.stopped = false; }
  start() {
    this.stopped = false;
    const enc = Buffer.from(SCRIPT(this.intervalSec), 'utf16le').toString('base64');
    this.proc = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', enc], { windowsHide: true });
    let buf = '';
    this.proc.stdout.setEncoding('utf8');
    this.proc.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line.startsWith('@@')) this.emit('tick', line.slice(2).split('|').filter(Boolean).map((p) => p.toLowerCase()));
      }
    });
    this.proc.on('exit', () => { this.proc = null; if (!this.stopped) setTimeout(() => this.start(), 5000); });
  }
  stop() { this.stopped = true; try { this.proc && this.proc.kill(); } catch {} }
}

module.exports = { Tracker };
