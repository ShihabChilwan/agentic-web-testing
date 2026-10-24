import { describe, expect, it } from 'vitest';
import { templateMatches, textPaths } from '../../src/shared/route-paths.js';

describe('route paths', () => {
  it('matches a path to a template: parameters in any style match one segment, query strings ignored', () => {
    expect(templateMatches('/product/:slug', '/product/blue-shirt')).toBe(true);
    expect(templateMatches('/product/:slug', '/product/<slug>')).toBe(true);
    expect(templateMatches('/api/items/{id}', '/api/items/42?x=1')).toBe(true);
    expect(templateMatches('/product/:slug', '/product')).toBe(false);
    expect(templateMatches('/dashboard', '/dashboard/orders')).toBe(false);
    expect(templateMatches('/', '/')).toBe(true);
  });

  it('finds paths in text, full URLs included, a bare base URL as "/", punctuation dropped', () => {
    expect(textPaths(['Open /login, then submit.', 'Go to http://localhost:8080/dashboard/orders.', 'Open http://localhost:8080 and sign in', 'GET /api/items/:id returns it'])).toEqual([
      '/login',
      '/dashboard/orders',
      '/',
      '/api/items/:id',
    ]);
    expect(textPaths(['and/or a value', 'no path here'])).toEqual([]);
  });
});
