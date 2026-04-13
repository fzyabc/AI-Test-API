const fs = require("fs/promises");
const path = require("path");

const dataDir = path.resolve(__dirname, "..", "data");
const settingsPath = path.join(dataDir, "settings.json");
const interfacesPath = path.join(dataDir, "interfaces.json");
const runsPath = path.join(dataDir, "runs.json");
const docContextsPath = path.join(dataDir, "doc-contexts.json");
const bugsPath = path.join(dataDir, "bugs.json");
const aiReportsDir = path.join(dataDir, "ai-reports");
const scenariosPath = path.join(dataDir, "scenarios.json");

const writeQueues = new Map();

async function ensureDataFiles() {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.mkdir(aiReportsDir, { recursive: true });
}

function queueFileWrite(filePath, writer) {
  const prev = writeQueues.get(filePath) || Promise.resolve();
  const current = prev.then(writer, writer);
  writeQueues.set(
    filePath,
    current.finally(() => {
      if (writeQueues.get(filePath) === current) {
        writeQueues.delete(filePath);
      }
    }),
  );
  return current;
}

async function waitForPendingWrite(filePath) {
  const pending = writeQueues.get(filePath);
  if (pending) {
    await pending;
  }
}

async function atomicWriteText(filePath, text) {
  await ensureDataFiles();
  const dir = path.dirname(filePath);
  const name = path.basename(filePath);
  const tmpPath = path.join(
    dir,
    `.${name}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`,
  );
  await fs.writeFile(tmpPath, text, "utf8");
  await fs.rename(tmpPath, filePath);
}

async function readJson(filePath, fallback) {
  await ensureDataFiles();
  await waitForPendingWrite(filePath);

  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
    const normalized = String(text || "").replace(/^\uFEFF/, "");
    return JSON.parse(normalized);
  } catch (error) {
    if (error.code === "ENOENT") {
      await writeJson(filePath, fallback);
      return fallback;
    }

    if (error instanceof SyntaxError) {
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      const backupPath = `${filePath}.corrupt-${stamp}.bak`;
      try {
        if (text) {
          await fs.writeFile(backupPath, text, "utf8");
        }
      } catch {
        // Ignore backup failure and still recover data file.
      }
      await writeJson(filePath, fallback);
      return fallback;
    }

    throw error;
  }
}

async function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  return queueFileWrite(filePath, async () => {
    await atomicWriteText(filePath, text);
  });
}

async function getSettings() {
  return readJson(settingsPath, {
    baseUrl: "",
    executionMode: "ai_agent",
    authProfiles: [],
    ai: {
      enabled: false,
      autoAnalyzeOnRun: false,
      url: "",
      apiKey: "",
      model: "",
      globalInstruction: "",
      unverifiedRunFillMode: "confirm",
      authMode: "api_key",
      oosToken: "",
      oosCookie: "",
      oosUserAgent: "",
      oosBrowserSessionId: "",
    },
  });
}

async function saveSettings(settings) {
  await writeJson(settingsPath, settings);
  return settings;
}

async function getInterfaces() {
  return readJson(interfacesPath, { interfaces: [] });
}

async function saveInterfaces(payload) {
  await writeJson(interfacesPath, payload);
  return payload;
}

async function getRuns() {
  return readJson(runsPath, { runs: [] });
}

async function saveRuns(payload) {
  await writeJson(runsPath, payload);
  return payload;
}

async function getDocContexts() {
  return readJson(docContextsPath, { docs: [] });
}

async function saveDocContexts(payload) {
  await writeJson(docContextsPath, payload);
  return payload;
}

async function getBugs() {
  return readJson(bugsPath, { bugs: [] });
}

async function saveBugs(payload) {
  await writeJson(bugsPath, payload);
  return payload;
}

async function getScenarios() {
  return readJson(scenariosPath, { scenarios: [] });
}

async function saveScenarios(payload) {
  await writeJson(scenariosPath, payload);
  return payload;
}

async function saveAiReport(runId, markdown) {
  await ensureDataFiles();
  const filePath = path.join(aiReportsDir, `${runId}.md`);
  await atomicWriteText(filePath, markdown);
  return filePath;
}

async function readAiReport(runId) {
  const filePath = path.join(aiReportsDir, `${runId}.md`);
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }
    throw error;
  }
}

async function deleteAiReport(runId) {
  const filePath = path.join(aiReportsDir, `${runId}.md`);
  try {
    await fs.unlink(filePath);
  } catch (error) {
    if (error.code !== "ENOENT") {
      throw error;
    }
  }
}

module.exports = {
  deleteAiReport,
  getBugs,
  getDocContexts,
  getInterfaces,
  getRuns,
  getScenarios,
  getSettings,
  readAiReport,
  saveBugs,
  saveDocContexts,
  saveAiReport,
  saveInterfaces,
  saveRuns,
  saveScenarios,
  saveSettings,
};
