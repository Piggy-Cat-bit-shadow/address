import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';

const css = await readFile(new URL('../src/components/LiteApp.css', import.meta.url), 'utf8');

describe('Address Lite private styling variables', () => {
  it('maps every Lite-private core variable inside lite-shell', () => {
    const shell = css.slice(css.indexOf('.lite-shell {'), css.indexOf('\n}', css.indexOf('.lite-shell {')));
    for (const variable of ['--text', '--border', '--border-strong', '--control', '--subtle', '--action-bg', '--action-text', '--focus-ring', '--card-shadow']) expect(shell).toContain(`${variable}:`);
  });

  it('keeps the visible control and state rules', () => {
    expect(css).toContain('border: 1px solid var(--border)');
    expect(css).toContain('border: 1px solid var(--border-strong)');
    expect(css).toContain('.lite-tabs button.active');
    expect(css).toContain('background: var(--action-bg)');
    expect(css).toContain('outline: 3px solid var(--focus-ring)');
  });
});
