import { describe, expect, it } from 'vitest';
import { AIJobQueue } from '@gi/ai';
import { detectPlaceholders } from '@gi/shared';

describe('AI cache invalidation', () => {
  it('returns cached result for same fingerprint', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    const a = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: true };
    });
    const b = await q.enqueue('classify', 'fp1', async () => {
      calls += 1;
      return { ok: false };
    });
    expect(a).toEqual(b);
    expect(calls).toBe(1);
  });

  it('recomputes when fingerprint changes', async () => {
    const q = new AIJobQueue();
    let calls = 0;
    await q.enqueue('summary', 'fp1', async () => {
      calls += 1;
      return 1;
    });
    await q.enqueue('summary', 'fp2', async () => {
      calls += 1;
      return 2;
    });
    expect(calls).toBe(2);
  });
});

describe('draft prompt placeholders', () => {
  it('shared detector finds unresolved facts', () => {
    expect(detectPlaceholders('Pay [AMOUNT] via [LINK]')).toEqual(['[AMOUNT]', '[LINK]']);
  });
});
