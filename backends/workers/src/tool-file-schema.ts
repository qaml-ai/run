import { isFileArgument } from '../../../src/core/file-arguments.ts';
export { isFileArgument, fileMode, fileSpec, acceptFiles, resolveFiles, need, takesFiles } from '../../../src/core/file-arguments.ts';
export type { FileArgument, FileSpec, FileValue } from '../../../src/core/file-arguments.ts';

export function hasFileArgument(value: unknown): boolean {
  return isFileArgument(value) || Array.isArray(value) && value.some(hasFileArgument) || !!value && typeof value === 'object' && Object.values(value).some(hasFileArgument);
}
