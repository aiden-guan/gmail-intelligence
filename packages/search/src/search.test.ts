import { describe, expect, it } from 'vitest';
import {
  formatCoverageWarning,
  LexicalSearchIndex,
  HybridRetriever,
  cosineSimilarity,
} from '@gi/search';

describe('lexical search', () => {
  it('indexes and retrieves by subject/body', () => {
    const idx = new LexicalSearchIndex();
    idx.upsert({
      id: 't1',
      threadId: 't1',
      subject: 'YC founder intro',
      text: 'Looking forward to connecting about the batch',
      senders: 'sama@ycombinator.com',
      recipients: 'me@example.com',
      labels: 'RESPOND',
      timestamp: '2026-06-01T00:00:00Z',
      fingerprint: 'fp1',
    });
    idx.upsert({
      id: 't2',
      threadId: 't2',
      subject: 'Receipt from Amazon',
      text: 'Your order has shipped',
      senders: 'auto@amazon.com',
      recipients: 'me@example.com',
      labels: 'NOTIFICATIONS',
      timestamp: '2026-06-02T00:00:00Z',
      fingerprint: 'fp2',
    });
    const hits = idx.search('YC founder');
    expect(hits[0]?.threadId).toBe('t1');
  });
});

describe('hybrid retrieval + citations', () => {
  it('returns top-k with thread ids for citations', () => {
    const idx = new LexicalSearchIndex();
    idx.upsert({
      id: 'a',
      threadId: 'thread-a',
      subject: 'Internship follow-up',
      text: 'Following up on the internship interview',
      senders: 'recruiter@co.com',
      recipients: 'me@example.com',
      labels: 'WAITING',
      timestamp: '2026-06-10T00:00:00Z',
      fingerprint: 'fpa',
    });
    const emb = [
      {
        fingerprint: 'fpa',
        threadId: 'thread-a',
        subject: 'Internship follow-up',
        vector: [1, 0, 0],
        timestamp: '2026-06-10T00:00:00Z',
      },
    ];
    const hybrid = new HybridRetriever(idx, emb);
    const hits = hybrid.retrieve({
      query: 'internship',
      queryEmbedding: [0.9, 0.1, 0],
      limit: 3,
    });
    expect(hits[0]?.threadId).toBe('thread-a');
    expect(hits.length).toBeLessThanOrEqual(3);
  });

  it('warns on partial index coverage', () => {
    const note = formatCoverageWarning({
      totalIndexedThreads: 1842,
      oldestIndexedDate: '2026-06-01T00:00:00Z',
      newestIndexedDate: '2026-09-01T00:00:00Z',
      state: 'partial',
    });
    expect(note).toMatch(/1,842 indexed threads/);
    expect(note).toMatch(/Coverage:/);
  });
});

describe('cosine', () => {
  it('computes similarity', () => {
    expect(cosineSimilarity([1, 0], [1, 0])).toBeCloseTo(1);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0);
  });
});
