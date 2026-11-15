const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const bcrypt = require('bcryptjs');
const { appRequest } = require('./test-support/app-request');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-api-'));
Object.assign(process.env, { SQLITE_PATH: path.join(dir, 'db.sqlite'), DATABASE_URL: '',
  AUTH_PASSWORD: 'fake-workspace-admin', GEMINI_API_KEY: '', APIFY_API_KEY: '', ANTHROPIC_API_KEY: '' });
const pool = require('./db');
const app = require('./index');
let adminCookie, modelCookie;
const request = (method, url, body, cookie = adminCookie) => appRequest(app, {
  method, path: url, body, headers: cookie ? { Cookie: cookie } : {},
});
before(async () => {
  await pool.initDB();
  await pool.query(`INSERT INTO models (id,name,primary_niche,email,password_hash,login_enabled,status)
    VALUES ($1,$2,$3,$4,$5,$6,$7)`, [11,'Logan','talking','workspace@example.test',bcrypt.hashSync('fake-model-password',4),1,'active']);
  await pool.query("INSERT INTO models (id,name,primary_niche,status) VALUES (12,'Gigi','talking','active')");
  const admin = await request('POST','/login',{password:'fake-workspace-admin'},null);
  adminCookie = admin.headers['set-cookie'][0].split(';')[0];
  const model = await request('POST','/login',{email:'workspace@example.test',password:'fake-model-password'},null);
  modelCookie = model.headers['set-cookie'][0].split(';')[0];
});
after(() => fs.rmSync(dir,{recursive:true,force:true}));

test('global approve without modelIds → 400 for single and bulk', async () => {
  await pool.query("INSERT INTO suggested_accounts (username,source) VALUES ('candidate','fake')");
  for (const modelIds of [undefined, [], ['11'], [0], [11,999]]) {
    const expected = modelIds?.includes(999) ? 404 : 400;
    assert.equal((await request('POST','/suggested/candidate/approve',{modelIds})).status,expected);
    assert.equal((await request('POST','/suggested/approve-bulk',{usernames:['candidate'],modelIds})).status,expected);
  }
  assert.equal((await pool.query('SELECT COUNT(*) AS count FROM model_creators')).rows[0].count,0);
});
test('global approve with two modelIds links both and creator active', async () => {
  const response = await request('POST','/suggested/Candidate/approve',{modelIds:[11,12]});
  assert.equal(response.status,200);
  assert.deepEqual((await pool.query("SELECT model_id,username FROM model_creators WHERE username='candidate' ORDER BY model_id")).rows,
    [{model_id:11,username:'candidate'},{model_id:12,username:'candidate'}]);
  assert.equal((await pool.query("SELECT status FROM tracked_accounts WHERE username='candidate'")).rows[0].status,'active');
});
test('bulk approval links all selected creators and GET suggested includes model statuses', async () => {
  await pool.query("INSERT INTO suggested_accounts (username,source) VALUES ('bulk-one','fake'),('bulk-two','fake')");
  const response = await request('POST','/suggested/approve-bulk',{usernames:['bulk-one','BULK-TWO'],modelIds:[11,12]});
  assert.equal(response.status,200);
  assert.equal(response.body.approved,2);
  const rows = (await request('GET','/suggested?status=approved')).body;
  assert.deepEqual(rows.find(r=>r.username==='bulk-one').models.map(m=>({modelId:m.modelId,status:m.status})),
    [{modelId:11,status:'approved'},{modelId:12,status:'approved'}]);
});
test('tracked owners and Unassigned are case-insensitive; deleting tracked creator clears ownership', async () => {
  await pool.query("INSERT INTO tracked_accounts (username,status) VALUES ('Unassigned','paused')");
  const all = (await request('GET','/tracked')).body;
  assert.deepEqual(all.find(r=>r.username==='candidate').owners,[{modelId:11,name:'Logan'},{modelId:12,name:'Gigi'}]);
  const unassigned = (await request('GET','/tracked?unassigned=true')).body;
  assert.deepEqual(unassigned.map(r=>r.username),['Unassigned']);
  assert.equal((await request('DELETE','/tracked/CANDIDATE')).status,200);
  assert.equal((await pool.query("SELECT COUNT(*) AS count FROM model_creators WHERE username='candidate'")).rows[0].count,0);
});
test('workspace routes require admin and preserve existing idea/save access rules', async () => {
  assert.equal((await request('GET','/workspaces/11',undefined,modelCookie)).status,403);
  await pool.query(`INSERT INTO posts (id,shortcode,account_handle,content_type,sort_status,video_cache_status,posted_at)
    VALUES (101,'old-source','Other.Creator','talking','auto','cached','2026-11-15')`);
  await pool.query("INSERT INTO idea_cards (model_id,batch_id,concept,source_post_ids) VALUES (11,'test','Idea','old-source')");
  assert.deepEqual((await request('GET','/me/feed',undefined,modelCookie)).body.posts,[]);
  assert.deepEqual((await request('GET','/me/ideas',undefined,modelCookie)).body.ideas[0].sourceReels,[]);
  await pool.query('INSERT INTO model_saved_posts (model_id,post_id) VALUES (11,101)');
  assert.deepEqual((await request('GET','/me/saves',undefined,modelCookie)).body.posts.map(p=>p.id),[101]);
});

test('global suggestions attach mixed-case reel previews and routed chips', async () => {
  await pool.query("INSERT INTO suggested_accounts (username,source) VALUES ('Mixed.Case','fake')");
  await pool.query("INSERT INTO suggested_reels (username,shortcode,rank) VALUES ('mixed.case','mixed-preview',1)");
  await pool.query("INSERT INTO model_suggestions (model_id,username,fit) VALUES (11,'mixed.case',0.75)");
  const response = await request('GET','/suggested');
  const account = response.body.find(r => r.username === 'Mixed.Case');
  assert.equal(account.top_reels.length,1);
  assert.equal(account.models[0].modelId,11);
});
