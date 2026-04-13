const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const backupDir = path.join(projectRoot, '.tmp-smoke-scenario-backup');
const fakeApiPort = 3321;
const appPort = 3317;

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function rmIfExists(targetPath) {
  fs.rmSync(targetPath, { recursive: true, force: true });
}

function copyIfExists(from, to) {
  if (fs.existsSync(from)) {
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}

function backupFiles(fileNames) {
  rmIfExists(backupDir);
  fs.mkdirSync(backupDir, { recursive: true });
  for (const name of fileNames) {
    copyIfExists(path.join(dataDir, name), path.join(backupDir, name));
  }
}

function restoreFiles(fileNames) {
  for (const name of fileNames) {
    const target = path.join(dataDir, name);
    const backup = path.join(backupDir, name);
    if (fs.existsSync(backup)) {
      fs.copyFileSync(backup, target);
    } else {
      rmIfExists(target);
    }
  }
  rmIfExists(backupDir);
}

async function waitForServer(url, attempts = 50) {
  for (let i = 0; i < attempts; i += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {}
    await wait(200);
  }
  throw new Error(`Server not ready: ${url}`);
}

async function main() {
  const fileNames = ['settings.json', 'interfaces.json', 'runs.json', 'bugs.json', 'scenarios.json'];
  backupFiles(fileNames);
  fs.mkdirSync(dataDir, { recursive: true });

  const fakeApi = http.createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/create-user') {
      let body = '';
      req.on('data', (chunk) => { body += chunk.toString(); });
      req.on('end', () => {
        const parsed = body ? JSON.parse(body) : {};
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ code: 200, message: 'ok', data: { userId: `user-${parsed.seed || 'x'}` } }));
      });
      return;
    }

    if (req.method === 'GET' && req.url.startsWith('/user/')) {
      const userId = req.url.split('/').pop();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, message: 'ok', data: { id: userId, status: 'active' } }));
      return;
    }

    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: 404, message: 'not found' }));
  });

  const app = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(appPort) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let appStdout = '';
  let appStderr = '';
  app.stdout.on('data', (chunk) => { appStdout += chunk.toString(); });
  app.stderr.on('data', (chunk) => { appStderr += chunk.toString(); });

  try {
    await new Promise((resolve, reject) => {
      fakeApi.once('error', reject);
      fakeApi.listen(fakeApiPort, '127.0.0.1', resolve);
    });

    fs.writeFileSync(path.join(dataDir, 'settings.json'), JSON.stringify({
      baseUrl: `http://127.0.0.1:${fakeApiPort}`,
      executionMode: 'case_runner',
      authProfiles: [],
      ai: { enabled: false, autoAnalyzeOnRun: false, url: '', apiKey: '', model: '', globalInstruction: '', authMode: 'api_key', oosToken: '', oosCookie: '', oosUserAgent: '', oosBrowserSessionId: '' },
    }, null, 2));

    fs.writeFileSync(path.join(dataDir, 'interfaces.json'), JSON.stringify({
      interfaces: [
        {
          id: 'create-user-api',
          name: 'Create User',
          method: 'POST',
          path: '/create-user',
          headers: {},
          bodyTemplate: '{"seed":"{{seed}}"}',
          cases: [
            {
              id: 'create-user-case',
              name: 'Create User OK',
              headers: {},
              pathParams: {},
              body: '{"seed":"{{seed}}"}',
              expected: { businessCode: 200 },
            },
          ],
        },
        {
          id: 'get-user-api',
          name: 'Get User',
          method: 'GET',
          path: '/user/{{userId}}',
          headers: {},
          bodyTemplate: '',
          cases: [
            {
              id: 'get-user-case',
              name: 'Get User OK',
              headers: {},
              pathParams: { userId: '{{userId}}' },
              body: '',
              expected: { businessCode: 200 },
            },
          ],
        },
      ],
    }, null, 2));

    fs.writeFileSync(path.join(dataDir, 'runs.json'), JSON.stringify({ runs: [] }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'bugs.json'), JSON.stringify({ bugs: [] }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'scenarios.json'), JSON.stringify({
      scenarios: [
        {
          id: 'scenario-1',
          name: 'Create then query user',
          description: 'smoke',
          steps: [
            {
              id: 'step-1',
              name: '创建用户',
              interfaceId: 'create-user-api',
              caseId: 'create-user-case',
              request: { body: { seed: 'abc123' } },
              extracts: [
                { name: 'userId', source: 'response.bodyJson', path: '$.data.userId' },
              ],
              assertions: [
                { type: 'exists', source: 'response.bodyJson', path: '$.data.userId' },
              ],
            },
            {
              id: 'step-2',
              name: '查询用户',
              interfaceId: 'get-user-api',
              caseId: 'get-user-case',
              request: { pathParams: { userId: '{{userId}}' } },
              assertions: [
                { type: 'equals', source: 'response.bodyJson', path: '$.data.id', expected: 'user-abc123' },
                { type: 'regex', source: 'response.bodyJson', path: '$.data.id', expected: '^user-' },
                { type: 'contains', source: 'response.bodyJson', path: '$.data.status', expected: 'act' },
                { type: 'length', source: 'response.bodyJson', path: '$.data.id', expected: 11 },
              ],
            },
          ],
        },
      ],
    }, null, 2));

    await waitForServer(`http://127.0.0.1:${appPort}/api/settings`);

    const response = await fetch(`http://127.0.0.1:${appPort}/api/scenarios/scenario-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const result = await response.json();
    if (!response.ok) throw new Error(`scenario run failed: ${JSON.stringify(result)}`);
    if (result.summary?.total !== 2 || result.summary?.passed !== 2 || result.summary?.failed !== 0) {
      throw new Error(`unexpected summary: ${JSON.stringify(result.summary)}`);
    }
    if (result.variables?.userId !== 'user-abc123') {
      throw new Error(`unexpected extracted variable: ${JSON.stringify(result.variables)}`);
    }

    console.log(JSON.stringify({ ok: true, summary: result.summary, variables: result.variables }, null, 2));
  } finally {
    app.kill('SIGTERM');
    await new Promise((resolve) => app.once('exit', resolve));
    await new Promise((resolve) => fakeApi.close(resolve));
    restoreFiles(fileNames);
    if (appStdout.trim()) {
      console.error('[app-stdout]');
      console.error(appStdout.trim());
    }
    if (appStderr.trim()) {
      console.error('[app-stderr]');
      console.error(appStderr.trim());
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
