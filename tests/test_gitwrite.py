"""Write routes against temporary real Git repositories (and a local bare remote)."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from git_review import api, gitwrite, gitx


class WriteTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='git-review-write-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'profile'
        self.home.mkdir()
        env = patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'GIT_CONFIG_GLOBAL': os.devnull,
                                     'GIT_CONFIG_NOSYSTEM': '1'})
        env.start()
        self.addCleanup(env.stop)
        api._allowed_cache.clear()
        self.repo = self.root / 'work' / 'repo'
        self.repo.mkdir(parents=True)
        self.git('init', '-b', 'main')
        self.git('config', 'user.name', 'Write Tester')
        self.git('config', 'user.email', 'write@example.invalid')
        (self.repo / 'a.txt').write_text('one\n', newline='\n')
        (self.repo / 'keep.txt').write_text('keep\n', newline='\n')
        self.git('add', '--all')
        self.git('commit', '-q', '-m', 'root')
        self.config()
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/git-review')
        self.client = TestClient(app)

    # helpers -----------------------------------------------------------------
    def git(self, *args, repo=None):
        return subprocess.check_output(['git', '-C', str(repo or self.repo), *args], text=True,
                                       stderr=subprocess.STDOUT).strip()

    def config(self, **settings):
        import yaml
        api._allowed_cache.clear()
        (self.home / 'config.yaml').write_text(yaml.safe_dump({'plugins': {'entries': {'git-review': {
            'settings': {'repos': str(self.repo), **settings}}}}}), newline='\n')

    def post(self, route, **body):
        return self.client.post('/api/plugins/git-review/' + route, json={'repo': str(self.repo), **body})

    def porcelain(self):
        return subprocess.check_output(['git', '-C', str(self.repo), 'status', '--porcelain',
                                        '--untracked-files=all'], text=True).rstrip('\n')

    def bare_remote(self):
        remote = self.root / 'origin.git'
        subprocess.check_call(['git', 'init', '-q', '--bare', '-b', 'main', str(remote)])
        self.git('remote', 'add', 'origin', str(remote))
        return remote

    # stage / unstage ---------------------------------------------------------
    def test_stage_one_file_then_unstage(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        self.assertEqual(self.post('stage', paths=['a.txt']).status_code, 200)
        self.assertIn('M  a.txt', self.porcelain())
        self.assertIn('?? new.txt', self.porcelain())
        self.assertEqual(self.post('unstage', paths=['a.txt']).status_code, 200)
        self.assertIn(' M a.txt', self.porcelain())
        self.assertEqual((self.repo / 'a.txt').read_text(), 'two\n')

    def test_stage_all_includes_deletions_and_new_files(self):
        (self.repo / 'keep.txt').unlink()
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        self.assertEqual(self.post('stage').status_code, 200)
        lines = self.porcelain().splitlines()
        self.assertIn('D  keep.txt', lines)
        self.assertIn('A  new.txt', lines)

    def test_unstage_on_unborn_branch(self):
        fresh = self.root / 'work' / 'fresh'
        fresh.mkdir()
        subprocess.check_call(['git', 'init', '-q', '-b', 'main', str(fresh)])
        (fresh / 'x.txt').write_text('x\n', newline='\n')
        self.git('add', 'x.txt', repo=fresh)
        gitwrite.unstage(str(fresh), ['x.txt'])
        self.assertEqual(self.git('status', '--porcelain', repo=fresh), '?? x.txt')

    def test_paths_are_literal_and_validated(self):
        # `[ab].txt` is a glob that matches a.txt, and a legal file name on every OS.
        (self.repo / '[ab].txt').write_text('glob\n', newline='\n')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        self.assertEqual(self.post('stage', paths=['[ab].txt']).status_code, 200)
        lines = self.porcelain().splitlines()
        self.assertIn('A  [ab].txt', lines)
        self.assertIn(' M a.txt', lines)  # the glob did not match a.txt
        for bad in ['../outside', '/etc/passwd', '--all', 'a/../../b', '']:
            with self.subTest(bad=bad):
                self.assertEqual(self.post('stage', paths=[bad]).status_code, 400)

    # discard -------------------------------------------------------------------
    def test_discard_restores_tracked_file_staged_and_unstaged(self):
        (self.repo / 'a.txt').write_text('staged\n', newline='\n')
        self.git('add', 'a.txt')
        (self.repo / 'a.txt').write_text('worktree\n', newline='\n')
        self.assertEqual(self.post('discard', paths=['a.txt']).status_code, 200)
        self.assertEqual((self.repo / 'a.txt').read_text(), 'one\n')
        self.assertEqual(self.porcelain(), '')

    def test_reads_and_writes_share_the_system_config(self):
        # Git for Windows keeps core.autocrlf in the system config. A discard that
        # honoured it while the reads did not left the restored file reading as modified.
        system = self.root / 'system.gitconfig'
        system.write_text('[core]\n\tautocrlf = true\n', newline='\n')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        env = {k: v for k, v in os.environ.items() if k != 'GIT_CONFIG_NOSYSTEM'}
        env['GIT_CONFIG_SYSTEM'] = str(system)
        with patch.dict(os.environ, env, clear=True):
            # A boolean: a failing assertIn would print the whole environment.
            self.assertFalse('GIT_CONFIG_NOSYSTEM' in gitx._git_env(), 'reads must not drop the system config')
            self.assertEqual(self.post('discard', paths=['a.txt']).status_code, 200)
            self.assertEqual((self.repo / 'a.txt').read_bytes(), b'one\r\n')
            files = self.client.get('/api/plugins/git-review/status', params={'repo': str(self.repo)}).json()['files']
        self.assertEqual(files, [])

    def test_discard_new_file_deletes_only_that_file(self):
        (self.repo / 'dir').mkdir()
        (self.repo / 'dir' / 'new.txt').write_text('new\n', newline='\n')
        (self.repo / 'dir' / 'other.txt').write_text('other\n', newline='\n')
        response = self.post('discard', paths=['dir/new.txt'])
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['deleted'], 1)
        self.assertFalse((self.repo / 'dir' / 'new.txt').exists())
        self.assertTrue((self.repo / 'dir' / 'other.txt').exists())

    def test_discard_staged_new_file_and_prunes_empty_dirs(self):
        (self.repo / 'd1' / 'd2').mkdir(parents=True)
        (self.repo / 'd1' / 'd2' / 'n.txt').write_text('n\n', newline='\n')
        self.git('add', '--all')
        self.assertEqual(self.post('discard', paths=['d1/d2/n.txt']).status_code, 200)
        self.assertFalse((self.repo / 'd1').exists())
        self.assertEqual(self.porcelain(), '')

    def test_discard_rename_restores_both_sides(self):
        self.git('mv', 'a.txt', 'b.txt')
        self.assertEqual(self.post('discard', paths=['b.txt', 'a.txt']).status_code, 200)
        self.assertTrue((self.repo / 'a.txt').exists())
        self.assertFalse((self.repo / 'b.txt').exists())
        self.assertEqual(self.porcelain(), '')

    def test_discard_all_keeps_ignored_files(self):
        (self.repo / '.gitignore').write_text('*.log\n', newline='\n')
        self.git('add', '.gitignore')
        self.git('commit', '-q', '-m', 'ignore')
        (self.repo / 'debug.log').write_text('log\n', newline='\n')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'keep.txt').unlink()
        (self.repo / 'n' / 'm').mkdir(parents=True)
        (self.repo / 'n' / 'm' / 'x.txt').write_text('x\n', newline='\n')
        self.assertEqual(self.post('discard').status_code, 200)
        self.assertEqual(self.porcelain(), '')
        self.assertTrue((self.repo / 'debug.log').exists())
        self.assertTrue((self.repo / 'keep.txt').exists())
        self.assertFalse((self.repo / 'n').exists())

    def test_discard_never_follows_a_symlinked_directory_out(self):
        outside = self.root / 'outside'
        outside.mkdir()
        (outside / 'victim.txt').write_text('keep me\n', newline='\n')
        try:
            (self.repo / 'link').symlink_to(outside, target_is_directory=True)
        except (OSError, NotImplementedError):
            self.skipTest('symlinks unavailable')
        response = self.post('discard', paths=['link/victim.txt'])
        self.assertEqual(response.status_code, 400, response.text)
        self.assertTrue((outside / 'victim.txt').exists())

    # commit / push ---------------------------------------------------------------
    def test_commit_stages_everything_when_nothing_is_staged(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        response = self.post('commit', message='feat: two files')
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(body['sha'], self.git('rev-parse', 'HEAD'))
        self.assertEqual(self.git('log', '-1', '--format=%s'), 'feat: two files')
        self.assertEqual(self.porcelain(), '')

    def test_commit_only_what_is_staged(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'keep.txt').write_text('changed\n', newline='\n')
        self.git('add', 'a.txt')
        self.assertEqual(self.post('commit', message='fix: a only').status_code, 200)
        self.assertEqual(self.git('show', '--name-only', '--format=', 'HEAD'), 'a.txt')
        self.assertIn(' M keep.txt', self.porcelain())

    def test_commit_rejects_empty_message_and_clean_tree(self):
        self.assertEqual(self.post('commit', message='   ').status_code, 400)
        response = self.post('commit', message='chore: nothing')
        self.assertEqual(response.status_code, 400)
        self.assertIn('nothing to commit', response.json()['detail'])

    def test_hooks_are_skipped_unless_repo_programs_are_allowed(self):
        hook = self.repo / '.git' / 'hooks' / 'pre-commit'
        marker = self.root / 'hook-ran'
        hook.write_text(f'#!/bin/sh\necho ran > "{marker}"\n', newline='\n')
        hook.chmod(0o755)
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        self.assertEqual(self.post('commit', message='one').status_code, 200)
        self.assertFalse(marker.exists())
        self.config(run_repo_programs=True)
        (self.repo / 'a.txt').write_text('three\n', newline='\n')
        self.assertEqual(self.post('commit', message='two').status_code, 200)
        self.assertTrue(marker.exists())

    def test_repo_filter_driver_refuses_stage_until_allowed(self):
        marker = self.root / 'filter-ran'
        self.git('config', 'filter.evil.clean', f"sh -c \"echo ran > '{marker.as_posix()}'; cat\"")
        (self.repo / '.gitattributes').write_text('*.txt filter=evil\n', newline='\n')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        response = self.post('stage', paths=['a.txt'])
        self.assertEqual(response.status_code, 409, response.text)
        self.assertIn('filter.evil.clean', response.json()['detail'])
        self.assertFalse(marker.exists())
        self.config(run_repo_programs=True)
        self.assertEqual(self.post('stage', paths=['a.txt']).status_code, 200)
        self.assertTrue(marker.exists())

    def test_repo_ssh_command_refuses_push(self):
        self.bare_remote()
        self.git('config', 'core.sshCommand', 'touch /nonexistent/never')
        response = self.post('push')
        self.assertEqual(response.status_code, 409, response.text)

    def test_commit_and_push_sets_upstream_then_pushes(self):
        remote = self.bare_remote()
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        response = self.post('commit', message='feat: ship', push=True)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['push']['upstream'], 'origin/main')
        self.assertEqual(self.git('rev-parse', 'main', repo=remote), self.git('rev-parse', 'HEAD'))
        (self.repo / 'a.txt').write_text('three\n', newline='\n')
        self.assertEqual(self.post('commit', message='feat: again').status_code, 200)
        ship = self.client.get('/api/plugins/git-review/ship', params={'repo': str(self.repo)}).json()
        self.assertEqual((ship['ahead'], ship['behind']), (1, 0))
        self.assertEqual(self.post('push').status_code, 200)
        self.assertEqual(self.git('rev-parse', 'main', repo=remote), self.git('rev-parse', 'HEAD'))

    def test_ship_says_when_a_pull_request_can_be_opened(self):
        ship = lambda: self.client.get('/api/plugins/git-review/ship', params={'repo': str(self.repo)}).json()
        self.assertFalse(ship()['pr_ready'], 'on main itself')
        self.git('checkout', '-q', '-b', 'feature')
        self.assertFalse(ship()['pr_ready'], 'a new branch with no commits of its own')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        self.git('commit', '-qam', 'feat: two')
        self.assertTrue(ship()['pr_ready'])

    def test_branch_tracking_another_name_publishes_under_its_own(self):
        # `git checkout -b feature origin/main`: the upstream is main. A push must never
        # land on main, whatever push.default says.
        origin = self.bare_remote()
        self.git('push', '-q', '-u', 'origin', 'main')
        self.git('checkout', '-q', '-b', 'feature', '--track', 'origin/main')
        self.git('config', 'push.default', 'upstream')
        (self.repo / 'a.txt').write_text('feature\n', newline='\n')
        self.git('commit', '-qam', 'feat: x')
        main_before = self.git('rev-parse', 'origin/main').strip()
        ship = self.client.get('/api/plugins/git-review/ship', params={'repo': str(self.repo)}).json()
        self.assertEqual(ship['upstream'], '', 'tracking another name is not published')
        r = self.client.post('/api/plugins/git-review/push', json={'repo': str(self.repo)})
        self.assertEqual(r.status_code, 200, r.text)
        remote = subprocess.run(['git', 'ls-remote', str(origin)], capture_output=True, text=True).stdout
        self.assertIn('refs/heads/feature', remote)
        self.assertIn(f'{main_before}\trefs/heads/main', remote, 'main untouched')

    def test_push_refuses_detached_head(self):
        self.bare_remote()
        self.git('checkout', '-q', '--detach')
        response = self.post('push')
        self.assertEqual(response.status_code, 400)
        self.assertIn('detached', response.json()['detail'])

    # policy / authorization ----------------------------------------------------
    def test_read_only_setting_refuses_every_write(self):
        self.config(read_only=True)
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        for route, body in [('stage', {}), ('unstage', {}), ('discard', {}), ('push', {}),
                            ('commit', {'message': 'x'}), ('create-pr', {})]:
            with self.subTest(route=route):
                self.assertEqual(self.post(route, **body).status_code, 403)
        self.assertEqual((self.repo / 'a.txt').read_text(), 'two\n')
        ship = self.client.get('/api/plugins/git-review/ship', params={'repo': str(self.repo)}).json()
        self.assertFalse(ship['writable'])

    def test_unconfigured_repository_is_refused(self):
        other = self.root / 'elsewhere'
        other.mkdir()
        subprocess.check_call(['git', 'init', '-q', '-b', 'main', str(other)])
        (other / 'x.txt').write_text('x\n', newline='\n')
        response = self.client.post('/api/plugins/git-review/stage', json={'repo': str(other)})
        self.assertEqual(response.status_code, 403)
        self.assertIn('?? x.txt', self.git('status', '--porcelain', repo=other))

    # commit context ---------------------------------------------------------------
    def test_commit_context_matches_what_would_be_committed(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        body = self.post('commit-context').json()
        self.assertFalse(body['staged'])
        self.assertIn('+two', body['diff'])
        self.assertIn('#   new.txt', body['diff'])
        self.assertEqual(body['recent'], 'root')
        self.git('add', 'a.txt')
        body = self.post('commit-context').json()
        self.assertTrue(body['staged'])
        self.assertNotIn('new.txt', body['diff'])

    def test_create_pr_needs_a_known_host(self):
        self.bare_remote()
        response = self.post('create-pr')
        self.assertEqual(response.status_code, 400)
        self.assertIn('GitHub or GitLab', response.json()['detail'])

    def test_create_pr_pushes_then_runs_gh_with_overrides(self):
        self.bare_remote()
        self.git('remote', 'set-url', 'origin', str(self.root / 'origin.git'))
        calls = []

        def fake_tool(cmd, *, cwd, timeout=12, extra_env=None):
            calls.append((cmd, extra_env))
            return 'Creating pull request\nhttps://github.com/o/r/pull/7\n'
        with patch.object(gitwrite, '_host', return_value='github'), \
                patch.object(gitx, '_run_tool', side_effect=fake_tool):
            response = self.post('create-pr')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['url'], 'https://github.com/o/r/pull/7')
        cmd, env = calls[0]
        self.assertEqual(cmd[:4], ['gh', 'pr', 'create', '--fill'])
        self.assertEqual(env['GIT_CONFIG_KEY_0'], 'core.fsmonitor')
        self.assertEqual(self.git('rev-parse', 'main', repo=self.root / 'origin.git'), self.git('rev-parse', 'HEAD'))

    # read scopes that the write actions rely on -------------------------------------
    def get(self, route, **params):
        return self.client.get('/api/plugins/git-review/' + route, params={'repo': str(self.repo), **params})

    def test_uncommitted_lists_new_files_only_when_asked(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        (self.repo / 'new.txt').write_text('fresh\n', newline='\n')
        plain = self.get('diff', scope='uncommitted').json()
        self.assertNotIn('new.txt', plain['patch'])
        full = self.get('diff', scope='uncommitted', untracked='true').json()
        self.assertIn('diff --git a/new.txt b/new.txt', full['patch'])
        self.assertIn('+fresh', full['patch'])
        self.assertEqual((full['added'], full['removed']), (2, 1))
        staged = self.get('diff', scope='staged', untracked='true').json()
        self.assertNotIn('new.txt', staged['patch'])
        only = self.get('diff', scope='unstaged', untracked='true', path='a.txt').json()
        self.assertNotIn('new.txt', only['patch'])

    def test_status_reports_staged_and_unstaged_per_file(self):
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        self.git('add', 'a.txt')
        (self.repo / 'a.txt').write_text('three\n', newline='\n')
        (self.repo / 'new.txt').write_text('n\n', newline='\n')
        files = {f['path']: f for f in self.get('status').json()['files']}
        self.assertEqual((files['a.txt']['staged'], files['a.txt']['unstaged']), (1, 1))
        self.assertTrue(files['new.txt']['untracked'])
        self.assertEqual((files['new.txt']['staged'], files['new.txt']['unstaged']), (0, 0))

    def test_branch_scope_is_the_net_change_since_the_fork_point(self):
        self.git('checkout', '-q', '-b', 'feature')
        (self.repo / 'a.txt').write_text('two\n', newline='\n')
        self.git('commit', '-q', '-am', 'one')
        (self.repo / 'a.txt').write_text('three\n', newline='\n')
        self.git('commit', '-q', '-am', 'two')
        (self.repo / 'keep.txt').write_text('uncommitted\n', newline='\n')
        body = self.get('diff', scope='branch').json()
        self.assertEqual(body['base_label'], 'main')
        self.assertEqual(body['head'], self.git('rev-parse', 'HEAD'))
        self.assertIn('-one\n+three', body['patch'])
        self.assertNotIn('keep.txt', body['patch'])
        self.assertEqual((body['added'], body['removed']), (1, 1))
        self.git('checkout', '-q', 'main')
        on_main = self.get('diff', scope='branch').json()
        self.assertEqual(on_main['patch'], '')
        self.assertIn('default branch', on_main['note'])
        against = self.get('diff', scope='branch', base='feature').json()
        self.assertEqual(against['patch'], '')
        self.assertEqual(self.get('diff', scope='branch', base='--evil').status_code, 400)


if __name__ == '__main__':
    unittest.main()
