const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const projectRoot = path.resolve(__dirname, '..');
const dataDir = path.join(projectRoot, 'data');
const backupDir = path.join(projectRoot, '.tmp-smoke-backup');
const fakeApiPort = 3320;
const appPort = 3316;

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
  const fileNames = ['settings.json', 'interfaces.json', 'runs.json', 'bugs.json'];
  backupFiles(fileNames);
  fs.mkdirSync(dataDir, { recursive: true });

  const fakeApi = http.createServer((req, res) => {
    if (req.url === '/ping') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: 200, message: 'ok', data: { pong: true } }));
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
  app.stdout.on('data', (chunk) => {
    appStdout += chunk.toString();
  });
  app.stderr.on('data', (chunk) => {
    appStderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      fakeApi.once('error', reject);
      fakeApi.listen(fakeApiPort, '127.0.0.1', resolve);
    });

    fs.writeFileSync(
      path.join(dataDir, 'settings.json'),
      JSON.stringify(
        {
          baseUrl: `http://127.0.0.1:${fakeApiPort}`,
          executionMode: 'case_runner',
          authProfiles: [],
          ai: {
            enabled: false,
            autoAnalyzeOnRun: false,
            url: '',
            apiKey: '',
            model: '',
            globalInstruction: '',
            authMode: 'api_key',
            oosToken: '',
            oosCookie: '',
            oosUserAgent: '',
            oosBrowserSessionId: '',
          },
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(
      path.join(dataDir, 'interfaces.json'),
      JSON.stringify(
        {
          interfaces: [
            {
              id: 'ping-interface',
              name: 'Ping',
              method: 'GET',
              path: '/ping',
              headers: {},
              bodyTemplate: '',
              cases: [
                {
                  id: 'ping-ok',
                  name: 'Ping OK',
                  headers: {},
                  pathParams: {},
                  body: '',
                  expected: { businessCode: 200 },
                  expectedMeta: {
                    businessCodeSource: 'ai_guess',
                    businessCodeVerified: false,
                    businessCodeUpdatedAt: '',
                  },
                },
              ],
            },
          ],
        },
        null,
        2,
      ),
    );

    fs.writeFileSync(path.join(dataDir, 'runs.json'), JSON.stringify({ runs: [] }, null, 2));
    fs.writeFileSync(path.join(dataDir, 'bugs.json'), JSON.stringify({ bugs: [] }, null, 2));

    await waitForServer(`http://127.0.0.1:${appPort}/api/settings`);

    const response = await fetch(`http://127.0.0.1:${appPort}/api/run-all`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });

    const run = await response.json();
    if (!response.ok) {
      throw new Error(`run-all failed: ${JSON.stringify(run)}`);
    }
    if (run.executionMode !== 'case_runner') {
      throw new Error(`Expected case_runner, got ${run.executionMode}`);
    }
    if (run.summary?.total !== 1 || run.summary?.passed !== 1 || run.summary?.failed !== 0) {
      throw new Error(`Unexpected summary: ${JSON.stringify(run.summary)}`);
    }

    const fillResponse = await fetch(`http://127.0.0.1:${appPort}/api/runs/${run.id}/fill-business-codes`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    const fillResult = await fillResponse.json();
    if (!fillResponse.ok) {
      throw new Error(`fill-business-codes failed: ${JSON.stringify(fillResult)}`);
    }
    if (fillResult.filledCount !== 0 || fillResult.skippedCount !== 1) {
      throw new Error(`Unexpected fill result: ${JSON.stringify(fillResult)}`);
    }

    const interfacesResponse = await fetch(`http://127.0.0.1:${appPort}/api/interfaces`);
    const interfacesPayload = await interfacesResponse.json();
    if (!interfacesResponse.ok) {
      throw new Error(`load interfaces failed: ${JSON.stringify(interfacesPayload)}`);
    }

    const expectedMeta = interfacesPayload.interfaces[0].cases[0].expectedMeta || {};
    if (expectedMeta.businessCodeVerified !== true || expectedMeta.businessCodeSource !== 'actual_run') {
      throw new Error(`Unexpected expectedMeta after fill: ${JSON.stringify(expectedMeta)}`);
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          executionMode: run.executionMode,
          summary: run.summary,
          runId: run.id,
          expectedMeta,
        },
        null,
        2,
      ),
    );
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
