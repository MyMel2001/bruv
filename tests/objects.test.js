const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BruvObjects = require('../src/core/objects');

test('objects: compressed write/read roundtrip with legacy raw fallback', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-obj-'));
  const objects = new BruvObjects(dir);

  const content = 'hello bruv '.repeat(100);
  const hash = objects.writeBlob(content);

  // Stored on disk compressed
  const stored = fs.readFileSync(objects.objectPath(hash));
  assert.ok(stored.length < content.length, 'stored object must be compressed');

  // Read back gives original content
  assert.strictEqual(objects.readBlob(hash).toString('utf8'), content);

  // Simulate legacy uncompressed object: same hash, raw bytes on disk
  fs.unlinkSync(objects.objectPath(hash));
  fs.writeFileSync(objects.objectPath(hash), Buffer.concat([Buffer.from('blob\0'), Buffer.from(content)]));
  assert.strictEqual(objects.readBlob(hash).toString('utf8'), content);
});

test('objects: importObjects rejects tampered content', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-imp-'));
  const objects = new BruvObjects(dir);
  const hash = objects.writeBlob('payload');
  const original = objects.readObject(hash);

  assert.throws(
    () => objects.importObjects([{ hash, type: 'blob', content: Buffer.from('evil').toString('base64') }]),
    /hash verification/
  );

  const imported = objects.importObjects([{ hash, type: 'blob', content: original.content.toString('base64') }]);
  assert.strictEqual(imported, 0); // already present
});

test('objects: PR refs stay stable across updates', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bruv-pr-'));
  const objects = new BruvObjects(dir);

  const prHash = objects.writePR({ title: 'T', sourceSnapshot: 'a', targetSnapshot: 'main', author: 'u' });
  const pr = objects.readPR(prHash);
  assert.ok(pr.id);
  const refsBefore = fs.readdirSync(path.join(objects.refsDir, 'prs'));
  assert.strictEqual(refsBefore.length, 1);

  objects.updatePR(prHash, { status: 'closed', comments: [{ author: 'u', body: 'c' }] });
  const reread = objects.readPR(pr.id);
  assert.strictEqual(reread.status, 'closed');
  assert.strictEqual(reread.comments.length, 1);
  assert.strictEqual(reread.title, 'T'); // preserved, not dropped
  assert.strictEqual(reread.timestamp, pr.timestamp); // timestamp not reset
  assert.strictEqual(fs.readdirSync(path.join(objects.refsDir, 'prs')).length, 1); // no stale refs
});
