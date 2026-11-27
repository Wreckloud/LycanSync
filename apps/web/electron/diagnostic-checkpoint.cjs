const { workerData, parentPort } = require('node:worker_threads');
const { createDiagnosticReportStore, prepareCheckpoint } = require('./diagnostic-reports.cjs');

async function save() {
  const { directory, state, text, context } = workerData;
  try {
    const bytes = await createDiagnosticReportStore(directory, state).save(await prepareCheckpoint(text, context));
    parentPort.postMessage({ bytes, state });
  } catch (error) {
    // 轮换成功后最终写入仍可能失败，下一次须沿用已经落盘的轮换状态。
    parentPort.postMessage({ error: { message: error.message, code: error.code }, state });
  }
}

void save();
