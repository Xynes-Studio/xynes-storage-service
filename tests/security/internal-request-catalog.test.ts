import { expect, test } from 'bun:test';
import { REGISTERED_ACTION_KEYS } from '../../src/composition';
import { INTERNAL_REQUEST_RECEIVERS } from '../../src/infra/security/internal-request';

test('receiver capabilities match the production composition action catalog', () => {
  expect([...INTERNAL_REQUEST_RECEIVERS['storage-service'].operations].sort()).toEqual(
    [...REGISTERED_ACTION_KEYS].sort(),
  );
});
