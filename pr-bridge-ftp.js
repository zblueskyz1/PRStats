#!/usr/bin/env node
/* ============================================================
   PROJECT REALISM — FTP stats bridge

   Logs into your Indifferent Broccoli server over FTP, grabs the
   pr_stats.json the mod writes, and publishes it where the website
   can read it.

   Runs on your PC or a small VPS. Never runs on the game server.

   Setup:
     1. npm install
     2. copy .env.example to .env and fill it in
     3. node pr-bridge-ftp.js

   Your credentials live in .env on your own machine. Nothing is
   sent anywhere except your own server and your own publish target.
   ============================================================ */

const fs = require('fs');
const path = require('path');
const { Client } = require('basic-ftp');
let SftpClient = null;
try { SftpClient = require('ssh2-sftp-client'); } catch (e) { /* only needed for sftp */ }

// ---------- tiny .env loader (no dependency needed) ----------
(function loadEnv() {
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
})();

const CFG = {
  protocol: (process.env.PROTOCOL || 'sftp').toLowerCase(),   // sftp | ftp
  host:     process.env.FTP_HOST,
  port:     parseInt(process.env.FTP_PORT || '21', 10),
  user:     process.env.FTP_USER,
  password: process.env.FTP_PASS,
  secure:   process.env.FTP_SECURE === 'true',
  remote:   process.env.FTP_REMOTE || '/server-data/Lua/pr_stats.json',
  everyMs:  parseInt(process.env.POLL_SECONDS || '60', 10) * 1000,

  mode:     process.env.PUBLISH_MODE || 'local',   // local | github
  localPath: process.env.LOCAL_PATH || './stats.json',
  ghRepo:   process.env.GITHUB_REPO,               // "user/repo"
  ghPath:   process.env.GITHUB_PATH || 'stats.json',
  ghToken:  process.env.GITHUB_TOKEN,
  ghBranch: process.env.GITHUB_BRANCH || 'main',
};

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

for (const k of ['host', 'user', 'password']) {
  if (!CFG[k]) {
    console.error('Missing FTP_' + k.toUpperCase() + ' — fill in your .env file first.');
    process.exit(1);
  }
}

// ---------- parsing ----------
function parseOrExplain(text) {
  const clean = text.replace(/^\uFEFF/, '').trim();     // strip any byte-order mark
  if (!clean) throw new Error('EMPTY_FILE: the mod created the file but wrote nothing to it');
  try {
    return JSON.parse(clean);
  } catch (e) {
    // The most common real cause is the mod appending instead of overwriting,
    // which leaves several JSON objects end to end. Recover the last one.
    const last = clean.lastIndexOf('{"');
    if (last > 0) {
      try {
        const obj = JSON.parse(clean.slice(last));
        log('note: file contains multiple JSON objects — using the last one');
        return obj;
      } catch (e2) { /* fall through to the report below */ }
    }
    const err = new Error('BAD_JSON: ' + e.message);
    err.sample = clean.length + ' bytes. Starts: ' + JSON.stringify(clean.slice(0, 180)) +
                 ' Ends: ' + JSON.stringify(clean.slice(-120));
    throw err;
  }
}

// ---------- fetch over SFTP (Indifferent Broccoli and most panels) ----------
async function pullSftp() {
  if (!SftpClient) throw new Error("ssh2-sftp-client not installed — run: npm install");
  const sftp = new SftpClient();
  try {
    await sftp.connect({
      host: CFG.host, port: CFG.port,
      username: CFG.user, password: CFG.password,
      readyTimeout: 20000,
    });
    const buf = await sftp.get(CFG.remote);
    return parseOrExplain(buf.toString('utf8'));
  } finally {
    try { await sftp.end(); } catch (e) {}
  }
}

// ---------- fetch over plain FTP / FTPS ----------
async function pullFtp() {
  const client = new Client(20000);
  client.ftp.verbose = process.env.FTP_DEBUG === 'true';
  const tmp = path.join(__dirname, '.pr_stats.tmp');
  try {
    await client.access({
      host: CFG.host, port: CFG.port,
      user: CFG.user, password: CFG.password,
      secure: CFG.secure,
    });
    await client.downloadTo(tmp, CFG.remote);
    const raw = fs.readFileSync(tmp, 'utf8');
    fs.unlinkSync(tmp);
    return parseOrExplain(raw);
  } finally {
    client.close();
  }
}

const pull = () => (CFG.protocol === 'ftp' ? pullFtp() : pullSftp());

// ---------- publish ----------
async function publishLocal(data) {
  const dest = path.resolve(CFG.localPath);
  const tmp = dest + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, dest);            // atomic — never serves half a file
  log('wrote', dest);
}

async function publishGithub(data) {
  if (!CFG.ghRepo || !CFG.ghToken) throw new Error('GITHUB_REPO and GITHUB_TOKEN required for github mode');
  const api = `https://api.github.com/repos/${CFG.ghRepo}/contents/${CFG.ghPath}`;
  const headers = {
    'Authorization': 'Bearer ' + CFG.ghToken,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'pr-bridge',
  };

  let sha;                              // github needs the current sha to overwrite
  const cur = await fetch(`${api}?ref=${CFG.ghBranch}`, { headers });
  if (cur.ok) sha = (await cur.json()).sha;
  else if (cur.status !== 404) throw new Error('github read failed: ' + cur.status);

  const res = await fetch(api, {
    method: 'PUT',
    headers: { ...headers, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: 'stats ' + new Date().toISOString(),
      content: Buffer.from(JSON.stringify(data)).toString('base64'),
      branch: CFG.ghBranch,
      ...(sha ? { sha } : {}),
    }),
  });
  if (!res.ok) throw new Error('github write failed: ' + res.status + ' ' + (await res.text()).slice(0, 160));
  log('pushed to', CFG.ghRepo + '/' + CFG.ghPath);
}

// ---------- loop ----------
let lastGood = 0, fails = 0;

async function tick() {
  try {
    const data = await pull();
    if (CFG.mode === 'github') await publishGithub(data);
    else await publishLocal(data);
    lastGood = Date.now(); fails = 0;
    log(`ok — ${data.online} online, ${data.safehouses} safehouses, ${data.totalPvpKills} pvp kills`);
  } catch (err) {
    fails++;
    const msg = String(err.message || err);
    if (msg.startsWith('EMPTY_FILE') || msg.startsWith('BAD_JSON')) {
      log('FAILED: ' + msg);
      if (err.sample) log('  content was: ' + err.sample);
      log('  -> check pr_stats.json in your file manager');
    } else if (fails === 1 || fails % 10 === 0) {
      log(`FAILED (${fails}x): ${msg}`);
      if (msg.includes('530') || msg.includes('authentication') || msg.includes('All configured authentication methods failed'))
        log('  -> login rejected, check FTP_USER / FTP_PASS');
      if (msg.includes('550') || msg.includes('No such file'))
        log('  -> file not found, check FTP_REMOTE points at pr_stats.json');
      if (msg.includes('ENOTFOUND') || msg.includes('ETIMEDOUT') || msg.includes('ECONNREFUSED'))
        log('  -> cannot reach FTP_HOST / FTP_PORT (SFTP is usually NOT port 21)');
      if (msg.includes('packet') || msg.includes('handshake'))
        log('  -> protocol mismatch: try PROTOCOL=ftp, or check the port');
    }
    if (lastGood && Date.now() - lastGood > 15 * 60 * 1000 && fails % 10 === 0) {
      log('  -> no successful pull in 15 minutes; the mod may not be writing the file');
    }
  }
}

// RUN_ONCE=true does a single pull and exits — that's how the
// GitHub Actions schedule uses it, so nothing needs to stay running.
if (process.env.RUN_ONCE === 'true') {
  log('single run — ' + CFG.protocol + '://' + CFG.host + CFG.remote);
  (async function () {
    for (let attempt = 1; attempt <= 3; attempt++) {
      await tick();
      if (!fails) break;                       // got it
      if (attempt < 3) {
        log('retrying in 8s...');
        await new Promise(r => setTimeout(r, 8000));
        fails = 0;
      }
    }
    process.exit(fails ? 1 : 0);
  })();
} else {
  log('bridge starting — ' + CFG.protocol + '://' + CFG.host + ':' + CFG.port + CFG.remote);
  log('publishing via ' + CFG.mode + ', every ' + (CFG.everyMs / 1000) + 's');
  tick();
  setInterval(tick, CFG.everyMs);
}
