import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const sourceRoot = join(__dirname, '..');

const sourceFiles = (directory: string): string[] =>
  readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);

    if (entry.isDirectory()) {
      return sourceFiles(path);
    }

    return entry.name.endsWith('.ts') && !entry.name.endsWith('.spec.ts')
      ? [path]
      : [];
  });

const files = sourceFiles(sourceRoot);

const KEYS_COMMAND = /(?<!Object)\.keys\s*\(|['"`]KEYS['"`]/;

describe('the KEYS command', () => {
  it('finds the production sources, so the check below is not vacuous', () => {
    expect(files.length).toBeGreaterThan(10);
    expect(files.some((path) => path.endsWith('hold-store.service.ts'))).toBe(
      true,
    );
    expect(files.some((path) => path.endsWith('sold-cache.service.ts'))).toBe(
      true,
    );
  });

  it.each(files)(
    'is absent from %s, because it blocks Redis for the whole keyspace',
    (path) => {
      expect(KEYS_COMMAND.test(readFileSync(path, 'utf8'))).toBe(false);
    },
  );

  it('would catch a reintroduced KEYS call rather than passing on any text', () => {
    expect(KEYS_COMMAND.test("await redis.keys('hold:*')")).toBe(true);
    expect(KEYS_COMMAND.test("redis.call('KEYS', pattern)")).toBe(true);
    expect(KEYS_COMMAND.test('const keys = [holdKey(1, 2)];')).toBe(false);
    expect(KEYS_COMMAND.test('Object.keys(payload).length')).toBe(false);
  });
});
