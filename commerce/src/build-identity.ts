import { readFile } from 'node:fs/promises';

export const PRODUCTION_BUILD_IDENTITY_FILE = '/app/identity/identity.json';

export interface BuildIdentity {
  readonly schema: 1;
  readonly service: 'mikluha-commerce';
  readonly sourceCommit: string;
}

export function parseBuildIdentity(value: unknown): BuildIdentity {
  const v = value as Partial<BuildIdentity> | null;
  if (v === null || typeof v !== 'object' || v.schema !== 1 || v.service !== 'mikluha-commerce'
      || typeof v.sourceCommit !== 'string' || !/^[0-9a-f]{40}$/.test(v.sourceCommit)) {
    throw new Error('BUILD_IDENTITY_INVALID');
  }
  return v as BuildIdentity;
}

export async function readBuildIdentity(file: string): Promise<BuildIdentity> {
  try {
    return parseBuildIdentity(JSON.parse(await readFile(file, 'utf8')));
  } catch (error) {
    if (error instanceof Error && error.message === 'BUILD_IDENTITY_INVALID') throw error;
    throw new Error('BUILD_IDENTITY_UNREADABLE');
  }
}
