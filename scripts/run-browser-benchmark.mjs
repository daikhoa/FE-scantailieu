import { spawn } from 'node:child_process';
import { access, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const targetUrl = process.argv[2];
if (!targetUrl) throw new Error('A local benchmark URL is required.');

const parsedTargetUrl = new URL(targetUrl);
if (
  parsedTargetUrl.protocol !== 'http:' ||
  parsedTargetUrl.username !== '' ||
  parsedTargetUrl.password !== '' ||
  (parsedTargetUrl.hostname !== '127.0.0.1' && parsedTargetUrl.hostname !== 'localhost')
) {
  throw new Error('The benchmark runner only accepts local URLs.');
}

const chromeCandidates = [
  process.env.CHROME_PATH,
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
].filter(Boolean);

async function findChrome() {
  for (const candidate of chromeCandidates) {
    try {
      await access(candidate);
      return candidate;
    } catch {
      // Try the next known location.
    }
  }
  throw new Error('Chrome was not found. Set CHROME_PATH to its executable.');
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function waitForChildTermination(child, timeoutMs) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolve) => {
      child.once('exit', resolve);
      child.once('close', resolve);
      child.once('error', resolve);
    }),
    delay(timeoutMs),
  ]);
}

async function waitForFile(path, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return await readFile(path, 'utf8');
    } catch {
      await delay(50);
    }
  }
  throw new Error('Chrome did not expose its debugging endpoint in time.');
}

async function waitForPage(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/list`);
      if (response.ok) {
        const targets = await response.json();
        const page = targets.find(
          (candidate) => candidate.type === 'page' && candidate.url === targetUrl,
        );
        if (page) return page;
      }
    } catch {
      // Chrome can accept HTTP shortly after creating DevToolsActivePort.
    }
    await delay(50);
  }
  throw new Error('The benchmark page did not open in time.');
}

function connectDevTools(webSocketUrl) {
  const socket = new WebSocket(webSocketUrl);
  const pending = new Map();
  let nextId = 0;

  const opened = new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('DevTools connection failed.')), {
      once: true,
    });
  });

  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (!message.id) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error('DevTools command failed.'));
    else request.resolve(message.result);
  });

  socket.addEventListener('close', () => {
    for (const request of pending.values()) request.reject(new Error('DevTools disconnected.'));
    pending.clear();
  });

  return {
    async send(method, params = {}) {
      await opened;
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() {
      socket.close();
    },
  };
}

async function waitForResult(client, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const response = await client.send('Runtime.evaluate', {
      expression: `(() => {
        const element = document.querySelector('#result');
        return element ? { status: element.dataset.status, text: element.textContent } : null;
      })()`,
      returnByValue: true,
    });
    const value = response.result?.value;
    if (value?.status === 'complete') return JSON.parse(value.text);
    if (value?.status === 'failed') throw new Error(`Benchmark failed: ${value.text}`);
    await delay(100);
  }
  throw new Error('The benchmark did not finish in time.');
}

const profileDirectory = await mkdtemp(join(tmpdir(), 'clonecamscanner-benchmark-'));
const chrome = await findChrome();
const child = spawn(
  chrome,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--remote-debugging-port=0',
    '--remote-debugging-address=127.0.0.1',
    '--remote-allow-origins=*',
    `--user-data-dir=${profileDirectory}`,
    targetUrl,
  ],
  { stdio: 'ignore', windowsHide: true },
);
const chromeStartupFailure = new Promise((_, reject) => {
  child.once('error', () => reject(new Error('Chrome failed to start.')));
});

let client;
let browserClient;
try {
  const [portLine, browserPath] = (
    await Promise.race([
      waitForFile(join(profileDirectory, 'DevToolsActivePort'), 10_000),
      chromeStartupFailure,
    ])
  )
    .trim()
    .split(/\r?\n/);
  const port = Number(portLine);
  if (!Number.isSafeInteger(port) || port <= 0) throw new Error('Chrome exposed an invalid port.');
  if (!browserPath?.startsWith('/devtools/browser/')) {
    throw new Error('Chrome exposed an invalid browser endpoint.');
  }
  browserClient = connectDevTools(`ws://127.0.0.1:${port}${browserPath}`);
  const page = await waitForPage(port, 10_000);
  client = connectDevTools(page.webSocketDebuggerUrl);
  await client.send('Runtime.enable');
  const result = await waitForResult(client, 120_000);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  client?.close();
  await browserClient?.send('Browser.close').catch(() => undefined);
  browserClient?.close();
  if (child.exitCode === null && child.signalCode === null) child.kill();
  await waitForChildTermination(child, 5_000);
  await rm(profileDirectory, {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 100,
  });
}
