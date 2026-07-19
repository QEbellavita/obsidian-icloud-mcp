'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const { createObsidianVaultService } = require('../src/service');

describe('Obsidian vault service', () => {
  let root;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-vault-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('rejects unknown vaults and unsafe note paths', () => {
    const service = createObsidianVaultService({ vaults: { Notes: root } });

    expect(() => service.readNote('Missing', 'note.md')).toThrow('Unknown vault');
    expect(() => service.readNote('Notes', '/tmp/note.md')).toThrow('relative');
    expect(() => service.readNote('Notes', '../note.md')).toThrow('inside the vault');
    expect(() => service.readNote('Notes', 'note.txt')).toThrow('Markdown');
  });

  test('rejects symlinks that escape the configured vault', () => {
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'obsidian-outside-'));
    fs.writeFileSync(path.join(outside, 'secret.md'), 'secret');
    fs.symlinkSync(outside, path.join(root, 'linked'));

    const service = createObsidianVaultService({ vaults: { Notes: root } });

    expect(() => service.readNote('Notes', 'linked/secret.md')).toThrow('inside the vault');
    fs.rmSync(outside, { recursive: true, force: true });
  });

  test('lists, searches, and reads Markdown notes', () => {
    fs.mkdirSync(path.join(root, 'nested'));
    fs.writeFileSync(path.join(root, 'zeta.md'), '# Zeta\nalpha beta');
    fs.writeFileSync(path.join(root, 'nested', 'alpha.md'), '# Alpha\nalpha backend');
    fs.writeFileSync(path.join(root, 'nested', 'ignore.txt'), 'Notes');
    const service = createObsidianVaultService({ vaults: { Notes: root } });

    expect(service.listNotes('Notes')).toEqual({
      vault: 'Notes',
      notes: ['nested/alpha.md', 'zeta.md'],
    });
    expect(service.searchNotes('Notes', 'backend', 1).matches).toEqual([
      { path: 'nested/alpha.md', line: 2, excerpt: 'alpha backend' },
    ]);
    expect(service.readNote('Notes', 'zeta.md').content).toBe('# Zeta\nalpha beta');
  });

  test('creates notes and atomically updates existing notes', () => {
    const service = createObsidianVaultService({ vaults: { Notes: root } });

    expect(service.createNote('Notes', 'new/note.md', '# New')).toEqual({
      vault: 'Notes', path: 'new/note.md', status: 'created',
    });
    expect(() => service.createNote('Notes', 'new/note.md', 'changed')).toThrow('already exists');
    expect(service.updateNote('Notes', 'new/note.md', '# Updated')).toEqual({
      vault: 'Notes', path: 'new/note.md', status: 'updated',
    });
    expect(service.readNote('Notes', 'new/note.md').content).toBe('# Updated');
    expect(() => service.updateNote('Notes', 'missing.md', 'nope')).toThrow('does not exist');
  });

  test('does not descend into directories that cannot hold notes', () => {
    // A vault that is also a source checkout: the walk must
    // skip VCS/dependency dirs and macOS model bundles instead of recursing through them.
    for (const dir of ['.git', '.obsidian', 'node_modules', 'activity.mlmodelc', 'attnres.mlpackage']) {
      fs.mkdirSync(path.join(root, dir), { recursive: true });
      fs.writeFileSync(path.join(root, dir, 'buried.md'), '# buried');
    }
    fs.writeFileSync(path.join(root, 'real.md'), '# real');

    const service = createObsidianVaultService({ vaults: { Notes: root } });

    expect(service.listNotes('Notes').notes).toEqual(['real.md']);
  });

  test('search stops at its deadline instead of hanging on evicted iCloud notes', () => {
    // Every note in the vault is a dataless iCloud placeholder, so each
    // readFileSync blocks on a network fetch. Search must bound that work and report the
    // truncation honestly rather than freeze the tool forever.
    for (let i = 0; i < 20; i++) fs.writeFileSync(path.join(root, `n${i}.md`), 'no match here');

    let clock = 0;
    const fsImpl = {
      ...fs,
      readFileSync: (...args) => {
        clock += 5000; // each evicted note costs ~5s to materialize
        return fs.readFileSync(...args);
      },
    };

    const service = createObsidianVaultService({
      vaults: { Notes: root },
      fsImpl,
      now: () => clock,
    });

    const result = service.searchNotes('Notes', 'zzz', 50, { deadlineMs: 12000 });

    expect(result.incomplete).toBe(true);      // told the truth about being cut short
    expect(result.scanned).toBeLessThan(20);   // did NOT grind through all 20 notes
    expect(clock).toBeLessThanOrEqual(20000);  // bounded work, not 100s
  });

  test('search never issues a blocking read on an unmaterialized (dataless) note', () => {
    // The deadline alone is not enough: a single readFileSync on an evicted iCloud file
    // blocks forever, so the between-files clock check is never reached. Detect dataless
    // files via stat (which does not block) and skip them instead of reading.
    fs.writeFileSync(path.join(root, 'evicted.md'), 'x'.repeat(500));
    fs.writeFileSync(path.join(root, 'local.md'), 'alpha beta');
    const evicted = path.join(fs.realpathSync(root), 'evicted.md');

    const fsImpl = {
      ...fs,
      statSync: (p, opts) => {
        const s = fs.statSync(p, opts);
        // macOS reports dataless files inconsistently: some keep their real size, others
        // report size=0. Only blocks===0 is reliable, so the evicted file here reports 0/0.
        if (String(p) === evicted) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { blocks: 0, size: 0 });
        return s;
      },
      readFileSync: (p, ...rest) => {
        if (String(p) === evicted) throw new Error('BLOCKED FOREVER: read of a dataless iCloud file');
        return fs.readFileSync(p, ...rest);
      },
    };

    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl, isDataless: (p) => String(p) === evicted });

    const result = service.searchNotes('Notes', 'beta');

    expect(result.matches.map((m) => m.path)).toEqual(['local.md']); // found the local one
    expect(result.unavailable).toBe(1);                              // reported the skipped one
    expect(result.incomplete).toBe(true);                            // did not claim completeness
  });

  test('reading an unmaterialized note fails honestly instead of blocking forever', () => {
    fs.writeFileSync(path.join(root, 'evicted.md'), 'cloud only');
    const evicted = path.join(fs.realpathSync(root), 'evicted.md');

    const fsImpl = {
      ...fs,
      statSync: (p, opts) => {
        const s = fs.statSync(p, opts);
        if (String(p) === evicted) return Object.assign(Object.create(Object.getPrototypeOf(s)), s, { blocks: 0, size: 0 });
        return s;
      },
      readFileSync: (p, ...rest) => {
        if (String(p) === evicted) throw new Error('BLOCKED FOREVER: read of a dataless iCloud file');
        return fs.readFileSync(p, ...rest);
      },
    };

    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl, isDataless: (p) => String(p) === evicted });

    expect(() => service.readNote('Notes', 'evicted.md')).toThrow(/not downloaded from iCloud/i);
  });

  test('an empty local note is not misreported as "not downloaded from iCloud"', () => {
    // A 0-byte local note also has blocks === 0, same as an evicted one. It must not be
    // counted as unavailable, or every search on a vault with one empty note would claim
    // to be incomplete and blame iCloud for a file that is right there.
    fs.writeFileSync(path.join(root, 'empty.md'), '');
    fs.writeFileSync(path.join(root, 'real.md'), 'alpha beta');

    const service = createObsidianVaultService({ vaults: { Notes: root } });

    const result = service.searchNotes('Notes', 'beta');

    expect(result.matches.map((m) => m.path)).toEqual(['real.md']);
    expect(result.unavailable).toBe(0);
    expect(result.incomplete).toBe(false);
  });

  test('search reports complete when it finishes within the deadline', () => {
    fs.writeFileSync(path.join(root, 'a.md'), 'alpha beta engine');
    const service = createObsidianVaultService({ vaults: { Notes: root } });

    const result = service.searchNotes('Notes', 'beta');

    expect(result.matches).toHaveLength(1);
    expect(result.incomplete).toBe(false);
  });

  test('never reads inside a stalling bundle dir (iCloud dataless readdir hangs forever)', () => {
    // Root cause of the hang: readdirSync on an evicted .mlmodelc bundle never returns.
    // An ignore list is only a real fix if the blocking syscall is never issued at all.
    fs.mkdirSync(path.join(root, 'stalls.mlmodelc'), { recursive: true });
    fs.writeFileSync(path.join(root, 'keep.md'), '# keep');

    // realpath: the service resolves the vault root, so /var/... becomes /private/var/... on macOS
    const tripwire = path.join(fs.realpathSync(root), 'stalls.mlmodelc');
    const fsImpl = {
      ...fs,
      readdirSync: (dir, opts) => {
        if (String(dir).startsWith(tripwire)) {
          throw new Error(`readdir descended into a bundle that would hang: ${dir}`);
        }
        return fs.readdirSync(dir, opts);
      },
    };

    const service = createObsidianVaultService({ vaults: { Notes: root }, fsImpl });

    expect(service.listNotes('Notes').notes).toEqual(['keep.md']);
  });
});
