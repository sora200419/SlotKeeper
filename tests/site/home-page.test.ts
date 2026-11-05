import { isValidElement, type ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import Home from '@/app/page';
import { SiteShell } from '@/components/SiteShell';

/** Every element in a rendered tree (server component output, not mounted). */
function elements(node: ReactNode): Array<{ type: unknown; props: Record<string, unknown> }> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<{ children?: ReactNode }>(node)) return [];
  return [{ type: node.type, props: node.props as Record<string, unknown> }, ...elements(node.props.children)];
}

function text(node: ReactNode): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  if (isValidElement<{ children?: ReactNode }>(node)) return text(node.props.children);
  return '';
}

describe('landing page', () => {
  it('links to booking and the staff board, and names the MCP endpoint', () => {
    const tree = Home();
    const hrefs = elements(tree)
      .filter((el) => el.type === 'a')
      .map((el) => el.props.href);
    expect(hrefs).toEqual(expect.arrayContaining(['/book', '/staff']));
    expect(text(tree)).toContain('/api/mcp');
  });

  it('is wrapped in the shared site shell', () => {
    expect(isValidElement(Home()) && Home().type).toBe(SiteShell);
  });
});

describe('site shell', () => {
  it('scopes its styles under .sk-site and links home, booking and staff', () => {
    const tree = SiteShell({ children: null });
    const all = elements(tree);
    expect(all[0].props.className).toBe('sk-site');
    const hrefs = all.filter((el) => el.type === 'a').map((el) => el.props.href);
    expect(hrefs).toEqual(expect.arrayContaining(['/', '/book', '/staff']));
  });
});
