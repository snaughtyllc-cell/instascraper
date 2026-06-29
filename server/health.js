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
  if (!isReady()) return res.status(503).json({ ready: false });
  // informational only — does not affect the latch
  let db = 'up';
  try { await (deps.db || require('./db')).query('SELECT 1'); } catch { db = 'down'; }
  return res.status(200).json({ ready: true, db });
};

module.exports = { markReady, isReady, resetForTest, assertThumbDirWritable, liveHandler, readyHandler };
