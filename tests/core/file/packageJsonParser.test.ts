import * as fs from 'node:fs/promises';
import * as url from 'node:url';
import path from 'node:path';
import { expect, test, describe, vi, beforeEach, afterEach } from 'vitest';
import { getVersion } from '../../../src/core/file/packageJsonParser.js';

vi.mock('fs/promises');
vi.mock('url');

describe('packageJsonParser', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('getVersion should return correct version from package.json', async () => {
    const mockPackageJson = {
      name: 'repopack',
      version: '1.2.3',
    };

    vi.mocked(url.fileURLToPath).mockReturnValue('/mock/path/to/src/core/file');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockPackageJson));

    const version = await getVersion();

    expect(version).toBe('1.2.3');
    expect(url.fileURLToPath).toHaveBeenCalledWith(expect.any(URL));
    expect(fs.readFile).toHaveBeenCalledWith(
      path.join('/mock/path/to/src/core/file', '..', '..', '..', 'package.json'),
      'utf-8',
    );
  });

  test('getVersion should handle missing version in package.json', async () => {
    const mockPackageJson = {
      name: 'repopack',
    };

    vi.mocked(url.fileURLToPath).mockReturnValue('/mock/path/to/src/core/file2');
    vi.mocked(fs.readFile).mockResolvedValue(JSON.stringify(mockPackageJson));

    const version = await getVersion();

    expect(version).toBe('unknown');
  });
});
