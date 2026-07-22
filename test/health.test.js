'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createObsidianVaultService } = require('../src/service');

// Simulate iCloud eviction the same way service.test.js does: an evicted file
// keeps its directory entry but reports blocks=0 (with a non-zero size — the
// unambiguous evicted signature), and any read of it would block forever.
function evictingFs(root, evictedRelPaths) {
  const evicted = new Set(evictedRelPaths.map((rel) => path.join(fs.realpathSync(root), rel)));
  const reads = [];
  return {
    reads,
    fsImpl: {
      ...fs,
      statSync: (p, opts) => {
        const s = fs.statSync(p, opts);
        if (evicted.has(String(p))) {
          return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { blocks: 0 });
        }
        return s;
      },
      promises: {
        readFile: async (p) => { reads.push(String(p)); return ''; },
      },
    },
  };
}

describe('vaultHealth', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-health-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('separates materialized from evicted and totals the pending bytes', () => {
    fs.writeFileSync(path.join(root, 'local.md'), 'here for real');
    fs.writeFileSync(path.join(root, 'gone-big.md'), 'x'.repeat(900));
    fs.writeFileSync(path.join(root, 'gone-small.md'), 'x'.repeat(100));
    const { fsImpl } = evictingFs(root, ['gone-big.md', 'gone-small.md']);
    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });

    const health = service.vaultHealth('Notes');
    expect(health).toMatchObject({
      vault: 'Notes',
      totalNotes: 3,
      scanned: 3,
      materialized: 1,
      evicted: 2,
      evictedBytes: 1000,
      unreadable: 0,
    });
    // largest first, so the worst offender is actionable at a glance
    expect(health.largestEvicted.map((e) => e.path)).toEqual(['gone-big.md', 'gone-small.md']);
    expect(health.note).toContain('obsidian_warm_notes');
  });

  test('a fully materialized vault reports clean with no advisory note', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'content');
    const service = createObsidianVaultService({ vaults: { Notes: root } });
    const health = service.vaultHealth('Notes');
    expect(health.evicted).toBe(0);
    expect(health.note).toBeUndefined();
  });

  test('the scan cap is reported as incomplete, never as a full answer', () => {
    for (let i = 0; i < 6; i += 1) fs.writeFileSync(path.join(root, `n${i}.md`), 'x');
    const service = createObsidianVaultService({ vaults: { Notes: root } });
    const health = service.vaultHealth('Notes', { maxNotes: 4 });
    expect(health.totalNotes).toBe(6);
    expect(health.scanned).toBe(4);
    expect(health.incomplete).toBe(true);
    expect(health.note).toContain('4/6');
  });

  test('never reads note contents — stat only, so it cannot hang on eviction', () => {
    fs.writeFileSync(path.join(root, 'gone.md'), 'x'.repeat(50));
    const { fsImpl } = evictingFs(root, ['gone.md']);
    fsImpl.readFileSync = () => { throw new Error('BLOCKED FOREVER: health must not read contents'); };
    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });
    expect(() => service.vaultHealth('Notes')).not.toThrow();
  });
});

describe('warmNotes', () => {
  let root;
  beforeEach(() => { root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-warm-')); });
  afterEach(() => { fs.rmSync(root, { recursive: true, force: true }); });

  test('discovers evicted notes and requests background downloads for them only', async () => {
    fs.writeFileSync(path.join(root, 'local.md'), 'already here');
    fs.writeFileSync(path.join(root, 'gone.md'), 'x'.repeat(50));
    const { fsImpl, reads } = evictingFs(root, ['gone.md']);
    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });

    const result = service.warmNotes('Notes');
    expect(result.requested).toBe(1);
    expect(result.paths).toEqual(['gone.md']);
    expect(result.status).toContain('background');

    await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toHaveLength(1);
    expect(reads[0]).toContain('gone.md');
  });

  test('explicit paths that are already local are reported, not re-downloaded', async () => {
    fs.writeFileSync(path.join(root, 'local.md'), 'already here');
    const { fsImpl, reads } = evictingFs(root, []);
    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });

    const result = service.warmNotes('Notes', { paths: ['local.md'] });
    expect(result).toMatchObject({ requested: 0, alreadyLocal: 1 });
    expect(result.status).toContain('Nothing to warm');

    await new Promise((resolve) => setImmediate(resolve));
    expect(reads).toHaveLength(0);
  });

  test('bounded by limit with the remainder reported honestly', () => {
    const rels = [];
    for (let i = 0; i < 5; i += 1) {
      const rel = `gone-${i}.md`;
      fs.writeFileSync(path.join(root, rel), 'x'.repeat(10));
      rels.push(rel);
    }
    const { fsImpl } = evictingFs(root, rels);
    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });

    const result = service.warmNotes('Notes', { limit: 2 });
    expect(result.requested).toBe(2);
    expect(result.remaining).toBe(3);
    expect(result.note).toContain('limit 2');
  });

  test('explicit paths outside the vault are rejected, not warmed', () => {
    const service = createObsidianVaultService({ vaults: { Notes: root } });
    expect(() => service.warmNotes('Notes', { paths: ['../outside.md'] })).toThrow('inside the vault');
  });
});
