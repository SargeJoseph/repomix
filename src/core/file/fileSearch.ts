import fs from 'node:fs/promises';
import path from 'node:path';
import { globby } from 'globby';
import { minimatch } from 'minimatch';
import type { RepomixConfigMerged } from '../../config/configSchema.js';
import { defaultIgnoreList } from '../../config/defaultIgnore.js';
import { logger } from '../../shared/logger.js';
import { sortPaths } from './filePathSort.js';
import { PermissionError, checkDirectoryPermissions } from './permissionCheck.js';

export interface FileSearchResult {
  filePaths: string[];
  emptyDirPaths: string[];
}

const findEmptyDirectories = async (
  rootDir: string,
  directories: string[],
  ignorePatterns: string[],
): Promise<string[]> => {
  const emptyDirs: string[] = [];

  for (const dir of directories) {
    const fullPath = path.join(rootDir, dir);
    try {
      const entries = await fs.readdir(fullPath);
      const hasVisibleContents = entries.some((entry) => !entry.startsWith('.'));

      if (!hasVisibleContents) {
        // This checks if the directory itself matches any ignore patterns
        const shouldIgnore = ignorePatterns.some((pattern) => minimatch(dir, pattern) || minimatch(`${dir}/`, pattern));

        if (!shouldIgnore) {
          emptyDirs.push(dir);
        }
      }
    } catch (error) {
      logger.debug(`Error checking directory ${dir}:`, error);
    }
  }

  return emptyDirs;
};

// Check if a path is a git worktree reference file
const isGitWorktreeRef = async (gitPath: string): Promise<boolean> => {
  try {
    const stats = await fs.stat(gitPath);
    if (!stats.isFile()) {
      return false;
    }

    const content = await fs.readFile(gitPath, 'utf8');
    return content.startsWith('gitdir:');
  } catch {
    return false;
  }
};

/**
 * Escapes special characters in glob patterns to handle paths with parentheses.
 * Example: "src/(categories)" -> "src/\\(categories\\)"
 */
const escapeGlobPattern = (pattern: string): string => {
  return pattern.replace(/[()[\]{}]/g, '\\$&');
};

// Get all file paths considering the config
export const searchFiles = async (rootDir: string, config: RepomixConfigMerged): Promise<FileSearchResult> => {
  // First check directory permissions
  const permissionCheck = await checkDirectoryPermissions(rootDir);

  if (!permissionCheck.hasPermission) {
    if (permissionCheck.error instanceof PermissionError) {
      throw permissionCheck.error;
    }
    throw new Error(`Cannot access directory ${rootDir}: ${permissionCheck.error?.message}`);
  }

  const includePatterns = config.include.length > 0 
    ? config.include.map(pattern => escapeGlobPattern(pattern))
    : ['**/*'];

  try {
    const [ignorePatterns, ignoreFilePatterns] = await Promise.all([
      getIgnorePatterns(rootDir, config),
      getIgnoreFilePatterns(config),
    ]);

    logger.trace('Include patterns:', includePatterns);
    logger.trace('Ignore patterns:', ignorePatterns);
    logger.trace('Ignore file patterns:', ignoreFilePatterns);

    // Check if .git is a worktree reference
    const gitPath = path.join(rootDir, '.git');
    const isWorktree = await isGitWorktreeRef(gitPath);

    // Modify ignore patterns for git worktree
    const adjustedIgnorePatterns = [...ignorePatterns];
    if (isWorktree) {
      // Remove '.git/**' pattern and add '.git' to ignore the reference file
      const gitIndex = adjustedIgnorePatterns.indexOf('.git/**');
      if (gitIndex !== -1) {
        adjustedIgnorePatterns.splice(gitIndex, 1);
        adjustedIgnorePatterns.push('.git');
      }
    }

    const filePaths = await globby(includePatterns, {
      cwd: rootDir,
      ignore: [...adjustedIgnorePatterns],
      ignoreFiles: [...ignoreFilePatterns],
      onlyFiles: true,
      absolute: false,
      dot: true,
      followSymbolicLinks: false,
    }).catch((error) => {
      // Handle EPERM errors specifically
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        throw new PermissionError(
          'Permission denied while scanning directory. Please check folder access permissions for your terminal app.',
          rootDir,
        );
      }
      throw error;
    });

    let emptyDirPaths: string[] = [];
    if (config.output.includeEmptyDirectories) {
      const directories = await globby(includePatterns, {
        cwd: rootDir,
        ignore: [...adjustedIgnorePatterns],
        ignoreFiles: [...ignoreFilePatterns],
        onlyDirectories: true,
        absolute: false,
        dot: true,
        followSymbolicLinks: false,
      });

      emptyDirPaths = await findEmptyDirectories(rootDir, directories, adjustedIgnorePatterns);
    }

    logger.trace(`Filtered ${filePaths.length} files`);

    return {
      filePaths: sortPaths(filePaths),
      emptyDirPaths: sortPaths(emptyDirPaths),
    };
  } catch (error: unknown) {
    // Re-throw PermissionError as is
    if (error instanceof PermissionError) {
      throw error;
    }

    if (error instanceof Error) {
      logger.error('Error filtering files:', error.message);
      throw new Error(`Failed to filter files in directory ${rootDir}. Reason: ${error.message}`);
    }

    logger.error('An unexpected error occurred:', error);
    throw new Error('An unexpected error occurred while filtering files.');
  }
};

export const parseIgnoreContent = (content: string): string[] => {
  if (!content) return [];

  return content.split('\n').reduce<string[]>((acc, line) => {
    const trimmedLine = line.trim();
    if (trimmedLine && !trimmedLine.startsWith('#')) {
      acc.push(trimmedLine);
    }
    return acc;
  }, []);
};

export const getIgnoreFilePatterns = async (config: RepomixConfigMerged): Promise<string[]> => {
  const ignoreFilePatterns: string[] = [];

  if (config.ignore.useGitignore) {
    ignoreFilePatterns.push('**/.gitignore');
  }

  ignoreFilePatterns.push('**/.repomixignore');

  return ignoreFilePatterns;
};

export const getIgnorePatterns = async (rootDir: string, config: RepomixConfigMerged): Promise<string[]> => {
  const ignorePatterns = new Set<string>();

  // Add default ignore patterns
  if (config.ignore.useDefaultPatterns) {
    logger.trace('Adding default ignore patterns');
    for (const pattern of defaultIgnoreList) {
      ignorePatterns.add(pattern);
    }
  }

  // Add repomix output file
  if (config.output.filePath) {
    const absoluteOutputPath = path.resolve(config.cwd, config.output.filePath);
    const relativeToTargetPath = path.relative(rootDir, absoluteOutputPath);

    logger.trace('Adding output file to ignore patterns:', relativeToTargetPath);

    ignorePatterns.add(relativeToTargetPath);
  }

  // Add custom ignore patterns
  if (config.ignore.customPatterns) {
    logger.trace('Adding custom ignore patterns:', config.ignore.customPatterns);
    for (const pattern of config.ignore.customPatterns) {
      ignorePatterns.add(pattern);
    }
  }

  return Array.from(ignorePatterns);
};
