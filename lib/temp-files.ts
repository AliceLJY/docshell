import { randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ImageAttachment } from './types';

const uidSuffix = typeof process.getuid === 'function' ? process.getuid() : 'user';
export const DEFAULT_TEMP_DIR = join(tmpdir(), `docshell-uploads-${uidSuffix}`);
export const MAX_UPLOAD_COUNT = 10;
export const MAX_SINGLE_FILE_SIZE = 20 * 1024 * 1024;

const MEDIA_EXTENSIONS = new Map<string, string>([
  ['image/png', 'png'],
  ['image/jpeg', 'jpg'],
  ['image/gif', 'gif'],
  ['image/webp', 'webp'],
  ['image/svg+xml', 'svg'],
  ['application/pdf', 'pdf'],
  ['text/plain', 'txt'],
  ['text/csv', 'csv'],
  ['text/html', 'html'],
  ['text/markdown', 'md'],
  ['application/json', 'json'],
  ['application/xml', 'xml'],
  ['application/octet-stream', 'bin'],
]);

async function removeIfPresent(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

async function ensurePrivateTempDir(tempDir: string): Promise<void> {
  await mkdir(tempDir, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(tempDir);
  if (directoryStat.isSymbolicLink() || !directoryStat.isDirectory()) {
    throw new Error('Temporary upload path must be a real directory, not a symbolic link');
  }
  if (typeof process.getuid === 'function' && directoryStat.uid !== process.getuid()) {
    throw new Error('Temporary upload directory must be owned by the current user');
  }
  await chmod(tempDir, 0o700);
}

export async function cleanupTempFiles(paths: string[]): Promise<void> {
  const results = await Promise.allSettled(paths.map(removeIfPresent));
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map((result) => result.reason);
  if (failures.length > 0) throw new AggregateError(failures, 'Failed to clean up temporary upload files');
}

/** Save uploaded files transactionally: any later validation/write failure removes every earlier path. */
export async function saveTempFiles(
  images: ImageAttachment[] | undefined,
  tempDir = DEFAULT_TEMP_DIR,
): Promise<string[]> {
  if (!images || images.length === 0) return [];
  if (images.length > MAX_UPLOAD_COUNT) {
    throw new Error(`Too many files: ${images.length} exceeds limit of ${MAX_UPLOAD_COUNT}`);
  }

  await ensurePrivateTempDir(tempDir);
  const paths: string[] = [];

  try {
    for (const image of images) {
      const extension = MEDIA_EXTENSIONS.get(image.mediaType);
      if (!extension) throw new Error(`Unsupported media type: ${image.mediaType}`);
      if (!image.base64 || image.base64.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(image.base64)) {
        throw new Error('Invalid base64 data');
      }

      const paddingBytes = image.base64.endsWith('==') ? 2 : image.base64.endsWith('=') ? 1 : 0;
      const estimatedSize = image.base64.length / 4 * 3 - paddingBytes;
      if (estimatedSize > MAX_SINGLE_FILE_SIZE) {
        throw new Error(`File too large: ${estimatedSize} bytes exceeds ${MAX_SINGLE_FILE_SIZE} byte limit`);
      }

      const filepath = join(tempDir, `upload-${randomUUID()}.${extension}`);
      const decoded = Buffer.from(image.base64, 'base64');
      if (decoded.toString('base64') !== image.base64 || decoded.length > MAX_SINGLE_FILE_SIZE) {
        throw new Error('Invalid or oversized base64 data');
      }
      // Register before writing so even a partially-created file is included in rollback.
      paths.push(filepath);
      await writeFile(filepath, decoded, { flag: 'wx', mode: 0o600 });
    }
    return paths;
  } catch (error) {
    try {
      await cleanupTempFiles(paths);
    } catch (rollbackError) {
      throw new AggregateError([error, rollbackError], 'Upload failed and temporary-file rollback was incomplete');
    }
    throw error;
  }
}
