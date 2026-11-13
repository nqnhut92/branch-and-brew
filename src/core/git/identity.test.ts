import { describe, expect, it } from 'vitest';
import { createRepo } from '../../../test/fixtures/repos';
import { checkIdentity, getIdentity, setIdentity } from './identity';

const work = { id: 'w', label: 'Work', name: 'Nick W', email: 'nick@work.example' };

describe('identity', () => {
  it('reads nothing in an isolated repo, then the local values with their scope', async () => {
    const f = await createRepo('id');
    // Isolate from the developer's own ~/.gitconfig.
    const env = { GIT_CONFIG_GLOBAL: `${f.dir}/../empty-gitconfig`, GIT_CONFIG_NOSYSTEM: '1' };
    try {
      // Fixtures carry a local identity; remove it to start from nothing.
      await f.git('config', '--unset', 'user.name');
      await f.git('config', '--unset', 'user.email');
      expect(await getIdentity(f.dir, { env })).toEqual({});
      await setIdentity(f.dir, 'local', { name: 'Nick W', email: 'nick@work.example' }, { env });
      expect(await getIdentity(f.dir, { env })).toEqual({
        name: 'Nick W', email: 'nick@work.example', nameScope: 'local', emailScope: 'local',
      });
      await setIdentity(f.dir, 'global', { name: 'Global', email: 'g@example.invalid' }, { env });
      expect((await getIdentity(f.dir, { env })).name).toBe('Nick W');
    } finally { f.dispose(); }
  });

  it('flags missing keys and a mismatch with the group profile', () => {
    expect(checkIdentity({ email: 'x@y' })).toEqual({ kind: 'missing', keys: ['user.name'] });
    expect(checkIdentity({ name: 'Nick W', email: 'NICK@work.example' }, work)).toBeUndefined();
    expect(checkIdentity({ name: 'Nick', email: 'nick@home' }, work)).toEqual({ kind: 'differs', profile: work });
    expect(checkIdentity({ name: 'Nick', email: 'nick@home' })).toBeUndefined();
  });
});
