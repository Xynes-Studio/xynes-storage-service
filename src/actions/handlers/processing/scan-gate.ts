import type { StorageProcessingJobRecord } from './types';
import type { StorageObjectRecord } from '../uploads/types';
import { isFinalizedSource } from '../uploads/finalized-source';

export type ScanValidationState = 'passed' | 'pending' | 'blocked';

/** Persisted, workspace-scoped scan evidence; aggregate object status is not proof. */
export function getScanValidationState(
  object: Pick<StorageObjectRecord, 'id' | 'workspaceId' | 'providerId' | 'providerObjectKey'>,
  jobs: ReadonlyArray<
    Pick<
      StorageProcessingJobRecord,
      'objectId' | 'jobType' | 'required' | 'status' | 'scanSourceKey' | 'scanProviderId'
    >
  >,
): ScanValidationState {
  const scans = jobs.filter(
    (job) => job.objectId === object.id && job.jobType === 'scan_validation',
  );
  if (
    !isFinalizedSource(object) ||
    scans.length === 0 ||
    scans.some(
      (scan) =>
        !scan.required ||
        !['succeeded', 'queued', 'running'].includes(scan.status) ||
        (scan.status === 'succeeded' &&
          (scan.scanSourceKey !== object.providerObjectKey ||
            scan.scanProviderId !== object.providerId)),
    )
  )
    return 'blocked';
  return scans.every((scan) => scan.status === 'succeeded') ? 'passed' : 'pending';
}
