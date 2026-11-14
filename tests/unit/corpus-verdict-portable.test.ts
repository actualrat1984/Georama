import { describe, expect, it } from 'vitest';
import { judgeCorpus, parseCorpusOutput } from '../helpers/corpus.ts';

// Portable corpus verdict and summary contracts, independent of filesystem discovery.
const CANNED = [
  'Invented Map 3.wonderdraft_map 4096000 12.5 1.5 0 20.1 IDENTICAL symbols=300 labels=20 paths=5 territories=7',
  'plain.wonderdraft_map 1200 3.2 0.5 2 2.3 DIFF@4096 symbols=2 labels=2 paths=1 territories=1',
  'WDCHECK maps=2 identical=1 issues=2',
  'ISSUE plain.wonderdraft_map /symbols[0]/radius symbol radius must be non-negative',
  'POINTS texts=10 identical=9',
  'R4 max-symbols Invented Map 3.wonderdraft_map: symbols=300 fromGd=1.8 toGd=2.7 read=12.5 write=20.1',
  'R4 max-bytes Invented Map 3.wonderdraft_map: bytes=4096000 fromGd=1.9 toGd=3.1 read=12.5 write=20.1',
  'RSS peak=321 MB',
].join('\n');

describe('parseCorpusOutput', () => {
  it('reads the per-file lines (names hold spaces), the totals, the R4 lines, the issue lines and the memory peak', () => {
    const p = parseCorpusOutput(CANNED);
    expect(p.maps).toBe(2);
    expect(p.identical).toBe(1);
    expect(p.issues).toBe(2);
    expect(p.pointsTexts).toBe(10);
    expect(p.pointsIdentical).toBe(9);
    expect(p.rssMb).toBe(321);
    expect(p.files).toEqual([
      { name: 'Invented Map 3.wonderdraft_map', bytes: 4096000, readMs: 12.5, validateMs: 1.5, issues: 0, writeMs: 20.1, verdict: 'IDENTICAL' },
      { name: 'plain.wonderdraft_map', bytes: 1200, readMs: 3.2, validateMs: 0.5, issues: 2, writeMs: 2.3, verdict: 'DIFF@4096' },
    ]);
    expect(p.r4).toHaveLength(2);
    expect(p.r4[0]).toContain('max-symbols');
    expect(p.issueLines).toEqual(['plain.wonderdraft_map /symbols[0]/radius symbol radius must be non-negative']);
  });

  it('gives zeros and an empty list for text that holds no totals', () => {
    const p = parseCorpusOutput('Error: something broke\n    at x (y.ts:1:1)\n');
    expect(p).toMatchObject({ maps: 0, identical: 0, issues: 0, pointsTexts: 0, pointsIdentical: 0, rssMb: null });
    expect(p.files).toEqual([]);
    expect(p.r4).toEqual([]);
  });
});

describe('judgeCorpus', () => {
  const good = { maps: 12, identical: 12, issues: 0, pointsTexts: 340, pointsIdentical: 340 };
  it('accepts only a run in which every map is identical, there are no issues and every points text round-trips', () => {
    expect(judgeCorpus(good, 0)).toEqual({ ok: true, reason: null });
  });
  it.each([
    ['a non-zero exit status', { ...good }, 1, /exit/],
    ['a killed process', { ...good }, null, /did not finish/],
    ['no maps', { ...good, maps: 0, identical: 0 }, 0, /no maps/],
    ['a map that is not identical', { ...good, identical: 11 }, 0, /not identical|differ/],
    ['validator issues', { ...good, issues: 1 }, 0, /issue/],
    ['a points text that does not round-trip', { ...good, pointsIdentical: 339 }, 0, /points/],
  ])('rejects %s', (_name, totals, exit, pattern) => {
    const j = judgeCorpus(totals, exit as number | null);
    expect(j.ok).toBe(false);
    expect(j.reason).toMatch(pattern);
  });
});
