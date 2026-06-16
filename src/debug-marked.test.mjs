import { Marked } from 'marked';
import { describe, it, expect } from 'vitest';

describe('debug marked', () => {
  it('should parse headers correctly', () => {
    const m = new Marked({ gfm: true, breaks: true });
    const result = m.parse('# Big Title\n## Sub Title');
    console.log('MARKED OUTPUT:', JSON.stringify(result));
    expect(result).toContain('<h2');
  });
  
  it('should parse lists correctly', () => {
    const m = new Marked({ gfm: true, breaks: true });
    const result = m.parse('- Item 1\n- Item 2\n- Item 3');
    console.log('MARKED LIST OUTPUT:', JSON.stringify(result));
    expect(result.match(/<li>/g)?.length).toBe(3);
  });
  
  it('should parse tables correctly', () => {
    const m = new Marked({ gfm: true, breaks: true });
    const result = m.parse('| A | B |\n|---|---|\n| 1 | 2 |');
    console.log('MARKED TABLE OUTPUT:', JSON.stringify(result));
    expect(result).toContain('<table');
  });
});
