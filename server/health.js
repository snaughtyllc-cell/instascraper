const fs = require('fs');
let ready = false;

function markReady() { ready = true; }
function isReady() { return ready; }
function resetForTest() { ready = false; }

function assertThumbDirWritable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const probe = require('path').join(dir, `.write-probe-${process.pid}`);
    fs.writeFileSync(probe, 'ok');
    fs.unlinkSync(probe);
    console.log(`[Boot] THUMB_DIR writable: ${dir}`);
    return true;
  } catch (err) {
    console.error(`[Boot] WARNING: THUMB_DIR not writable (${dir}): ${err.message}`);
    return false;
  }
}

const liveHandler = (req, res) => res.status(200).json({ status: 'live' });
const readyHandler = (deps = {}) => async (req, res) => {
  // Strict readiness: 503 until the first successful init (deploy gate — init
  // requires the DB), then 503 whenever the live DB probe fails.
  if (!isReady()) return res.status(503).json({ ready: false, reason: 'initializing' });
  try {
    await (deps.db || require('./db')).query('SELECT 1');
  } catch {
    return res.status(503).json({ ready: false, db: 'down' });
  }
  return res.status(200).json({ ready: true, db: 'up' });
};

module.exports = { markReady, isReady, resetForTest, assertThumbDirWritable, liveHandler, readyHandler };
