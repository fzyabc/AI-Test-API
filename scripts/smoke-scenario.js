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
              onFailure: 'stop',
              request: { body: { seed: 'abc123' } },
              extracts: [
                { name: 'flow.userId', source: 'response.bodyJson', path: '$.data.userId' },
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
              onFailure: 'stop',
              request: { pathParams: { userId: '{{flow.userId}}' } },
              assertions: [
                { type: 'equals', source: 'response.bodyJson', path: '$.data.id', expected: 'user-abc123' },
                { type: 'regex', source: 'response.bodyJson', path: '$.data.id', expected: '^user-' },
                { type: 'contains', source: 'response.bodyJson', path: '$.data.status', expected: 'act' },
                { type: 'length', source: 'response.bodyJson', path: '$.data.id', expected: 11 },
              ],
            },
          ],
        },
        {
          id: 'scenario-2',
          name: 'Jump on failure',
          description: 'jump branch smoke',
          steps: [
            {
              id: 'jump-step-1',
              name: '创建用户并提取',
              interfaceId: 'create-user-api',
              caseId: 'create-user-case',
              onFailure: 'stop',
              request: { body: { seed: 'jump01' } },
              extracts: [
                { name: 'flow.userId', source: 'response.bodyJson', path: '$.data.userId' },
              ],
            },
            {
              id: 'jump-step-2',
              name: '故意失败后跳清理',
              interfaceId: 'get-user-api',
              caseId: 'get-user-case',
              onFailure: 'jump',
              nextStepId: 'jump-step-4',
              request: { pathParams: { userId: '{{flow.userId}}' } },
              assertions: [
                { type: 'equals', source: 'response.bodyJson', path: '$.data.id', expected: 'wrong-id' },
              ],
            },
            {
              id: 'jump-step-3',
              name: '这一段应被跳过',
              interfaceId: 'get-user-api',
              caseId: 'get-user-case',
              onFailure: 'stop',
              request: { pathParams: { userId: '{{flow.userId}}' } },
            },
            {
              id: 'jump-step-4',
              name: '跳转后的收尾校验',
              interfaceId: 'get-user-api',
              caseId: 'get-user-case',
              onFailure: 'stop',
              request: { pathParams: { userId: '{{flow.userId}}' } },
              assertions: [
                { type: 'equals', source: 'response.bodyJson', path: '$.data.id', expected: 'user-jump01' },
              ],
            },
          ],
        },
      ],
    }, null, 2));

    await waitForServer(`http://127.0.0.1:${appPort}/api/settings`);

    const response1 = await fetch(`http://127.0.0.1:${appPort}/api/scenarios/scenario-1/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const result1 = await response1.json();
    if (!response1.ok) throw new Error(`scenario-1 run failed: ${JSON.stringify(result1)}`);
    if (result1.summary?.total !== 2 || result1.summary?.executed !== 2 || result1.summary?.passed !== 2 || result1.summary?.failed !== 0 || result1.summary?.skipped !== 0) {
      throw new Error(`unexpected scenario-1 summary: ${JSON.stringify(result1.summary)}`);
    }
    if (result1.variables?.flow?.userId !== 'user-abc123') {
      throw new Error(`unexpected extracted variable: ${JSON.stringify(result1.variables)}`);
    }

    const response2 = await fetch(`http://127.0.0.1:${appPort}/api/scenarios/scenario-2/run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const result2 = await response2.json();
    if (!response2.ok) throw new Error(`scenario-2 run failed: ${JSON.stringify(result2)}`);
    if (result2.summary?.total !== 4 || result2.summary?.executed !== 3 || result2.summary?.passed !== 2 || result2.summary?.failed !== 1 || result2.summary?.skipped !== 1) {
      throw new Error(`unexpected scenario-2 summary: ${JSON.stringify(result2.summary)}`);
    }
    const executedNames = (result2.results || []).filter((item) => !item.skipped).map((item) => item.stepName);
    if (executedNames.join('|') !== '创建用户并提取|故意失败后跳清理|跳转后的收尾校验') {
      throw new Error(`unexpected execution path: ${executedNames.join('|')}`);
    }

    console.log(JSON.stringify({ ok: true, scenario1: result1.summary, scenario2: result2.summary, variables: result1.variables }, null, 2));
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
