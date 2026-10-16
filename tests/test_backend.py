"""Backend audit regressions using temporary real Git repositories."""
from contextlib import closing
import importlib.util
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch
from fastapi import FastAPI
from fastapi.testclient import TestClient
from git_review import api, gitx, select_store, select_tool


def posix(path):
    """Paths are reported with forward slashes; native strings differ on Windows."""
    return str(path).replace("\\", "/")


class BackendTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory(prefix='git-review-audit-', dir=os.environ.get('TMPDIR'))
        self.addCleanup(self.tmp.cleanup)
        self.root = Path(self.tmp.name).resolve()
        self.home = self.root / 'profile'
        self.home.mkdir()
        env = patch.dict(os.environ, {'HERMES_HOME': str(self.home), 'GIT_CONFIG_GLOBAL': os.devnull,
                                     'GIT_CONFIG_NOSYSTEM': '1'})
        env.start()
        self.addCleanup(env.stop)
        self.repo = self.make_repo(self.root / 'workspace' / 'category' / 'repo')
        (self.repo / 'file.txt').write_text('one\ntwo\n', newline='\n')
        self.first = self.commit('root')
        app = FastAPI()
        app.include_router(api.router, prefix='/api/plugins/git-review')
        self.client = TestClient(app)

    def test_removed_scopes_are_unknown(self):
        for scope in ['branch', 'commit', 'range']:
            with self.subTest(scope=scope), self.assertRaises(gitx.GitError):
                gitx.diff(self.repo, scope, base='main', ref=self.first)

    def post(self, route, **body):
        return self.client.post('/api/plugins/git-review/' + route, json=body)

    def test_agent_turn_scope_removed(self):
        self.assertNotIn('agent_turn', gitx.SCOPES)
        self.assertEqual(select_tool.SCHEMA['properties']['scope']['enum'], list(gitx.SCOPES))
        with self.assertRaises(gitx.GitError):
            gitx.diff(self.repo, 'agent_turn')
        self.config(repos=str(self.repo))
        self.assertEqual(self.post('diff-paths', repo=str(self.repo), paths=['file.txt']).status_code, 404)

    def test_turn_base_snapshot(self):
        self.config(repos=str(self.repo))
        (self.repo / 'pre.txt').write_text('pre\n', newline='\n')
        (self.repo / 'sub').mkdir()
        (self.repo / 'sub' / 'pre2.txt').write_text('pre2\n', newline='\n')
        (self.repo / '.gitignore').write_text('ignored.log\n', newline='\n')
        (self.repo / 'ignored.log').write_text('x\n', newline='\n')
        index = (self.repo / '.git' / 'index').read_bytes()
        objects = self.git('count-objects', '-v')
        response = self.post('turn-base', repo=str(self.repo / 'sub'))
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertEqual(posix(body['repo']), posix(self.repo))
        self.assertEqual(body['base'], self.first)
        self.assertEqual(sorted(body['untracked']), ['.gitignore', 'pre.txt', 'sub/pre2.txt'])
        self.assertFalse(body['untracked_truncated'])
        self.assertEqual((self.repo / '.git' / 'index').read_bytes(), index)
        self.assertEqual(self.git('count-objects', '-v'), objects)

    def test_turn_diff_shows_commit_edit_and_new_untracked_not_preexisting(self):
        self.config(repos=str(self.repo))
        (self.repo / 'other.txt').write_text('a\n', newline='\n')
        self.commit('other')
        (self.repo / 'pre.txt').write_text('pre-existing\n', newline='\n')
        snap = self.post('turn-base', repo=str(self.repo)).json()
        self.assertEqual(snap['untracked'], ['pre.txt'])
        # The agent turn: commit a change, edit a tracked file, create a new file.
        (self.repo / 'other.txt').write_text('a\ncommitted\n', newline='\n')
        self.git('add', 'other.txt')
        self.git('commit', '-m', 'turn commit')
        (self.repo / 'file.txt').write_text('one\ntwo\nedited\n', newline='\n')
        (self.repo / 'pre.txt').write_text('pre-existing\nchanged during turn\n', newline='\n')
        (self.repo / 'new dir').mkdir()
        (self.repo / 'new dir' / 'brand new.txt').write_text('fresh\nfile\n', newline='\n')
        response = self.post('turn-diff', repo=str(self.repo), base=snap['base'],
                             preexisting_untracked=snap['untracked'])
        self.assertEqual(response.status_code, 200, response.text)
        body = response.json()
        self.assertIn('+committed', body['patch'])
        self.assertIn('+edited', body['patch'])
        self.assertIn('diff --git a/new dir/brand new.txt b/new dir/brand new.txt', body['patch'])
        self.assertIn('+fresh', body['patch'])
        self.assertNotIn('pre-existing', body['patch'])
        self.assertEqual((body['added'], body['removed']), (4, 0))
        self.assertEqual(body['note'], '')
        # Without the snapshot the pre-existing file appears.
        self.assertIn('+pre-existing', self.post('turn-diff', repo=str(self.repo), base=snap['base']).json()['patch'])
        # Whitespace-only tracked change is hidden with ignore_ws.
        (self.repo / 'file.txt').write_text('one  \ntwo\n', newline='\n')
        body = self.post('turn-diff', repo=str(self.repo), base=self.git('rev-parse', 'HEAD'),
                         preexisting_untracked=['pre.txt', 'new dir/brand new.txt'], ignore_ws=True).json()
        self.assertEqual(body['patch'], '')

    def test_turn_diff_unborn_repository(self):
        self.repo = self.make_repo(self.root / 'unborn')
        self.config(repos=str(self.repo))
        (self.repo / 'old.txt').write_text('old\n', newline='\n')
        snap = self.post('turn-base', repo=str(self.repo)).json()
        self.assertIsNone(snap['base'])
        self.assertEqual(snap['untracked'], ['old.txt'])
        (self.repo / 'staged.txt').write_text('staged\n', newline='\n')
        self.git('add', 'staged.txt')
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        body = self.post('turn-diff', repo=str(self.repo), base=None,
                         preexisting_untracked=snap['untracked']).json()
        self.assertIn('+staged', body['patch'])
        self.assertIn('+new', body['patch'])
        self.assertNotIn('old', body['patch'])
        self.assertEqual(body['added'], 2)

    def test_turn_routes_validation(self):
        self.config(repos=str(self.repo))
        for base in ['HEAD', '--output=x', 'main', 'f' * 40, self.first + '^']:
            with self.subTest(base=base):
                self.assertEqual(self.post('turn-diff', repo=str(self.repo), base=base).status_code, 400)
        tree = self.git('rev-parse', 'HEAD^{tree}')
        self.assertEqual(self.post('turn-diff', repo=str(self.repo), base=tree).status_code, 400)
        self.assertEqual(self.post('turn-diff', repo=str(self.repo), base=self.first[:12]).status_code, 200)
        for bad in ['../x', '/etc/passwd', '--x', 'a\x00b', '', 'a/../b', './a', 'a\nb', ' a']:
            with self.subTest(bad=bad):
                self.assertEqual(self.post('turn-diff', repo=str(self.repo), base=self.first,
                                           preexisting_untracked=[bad]).status_code, 400)
        self.assertEqual(self.post('turn-diff', repo=str(self.repo), base=self.first,
                                   preexisting_untracked=['x'] * (gitx.MAX_FILES + 1)).status_code, 422)

    def test_turn_diff_bounds_untracked_count_and_bytes(self):
        self.config(repos=str(self.repo))
        for i in range(5):
            (self.repo / f'n{i}.txt').write_text(f'{i}\n', newline='\n')
        with patch.object(gitx, 'MAX_TURN_UNTRACKED', 3):
            body = gitx.turn_diff(self.repo, self.first, [])
        self.assertEqual(body['patch'].count('diff --git'), 3)
        self.assertIn('2 new untracked files omitted', body['note'])
        with patch.object(gitx, 'MAX_DIFF_BYTES', 200):
            body = gitx.turn_diff(self.repo, self.first, [])
        self.assertLess(len(body['patch']), 200)
        self.assertIn('display limit', body['note'])
        (self.repo / 'file.txt').write_text('x' * (gitx.MAX_DIFF_BYTES + 70000), newline='\n')
        body = gitx.turn_diff(self.repo, self.first, [])
        self.assertEqual(body['patch'], '')
        self.assertIn('limit', body['note'])

    def test_new_routes_refuse_unauthorized_repository(self):
        self.config()
        with patch.object(gitx, 'session_cwds', return_value=[]), \
                patch.object(select_store, 'latest', return_value=None):
            for route, body in [('turn-base', {}), ('turn-diff', {'base': self.first}),
                                ('file-lines', {'path': 'file.txt', 'rev': 'worktree', 'start': 1, 'end': 1})]:
                with self.subTest(route=route):
                    response = self.post(route, repo=str(self.repo), cwd=str(self.repo), **body)
                    self.assertEqual(response.status_code, 403, response.text)

    def file_lines(self, **body):
        return self.post('file-lines', repo=str(self.repo), **body)

    def test_file_lines_revisions_and_clamping(self):
        self.config(repos=str(self.repo))
        (self.repo / 'long.txt').write_text(''.join(f'c{i}\n' for i in range(1, 11)), newline='\n')
        sha = self.commit('long')
        (self.repo / 'long.txt').write_text(''.join(f'i{i}\n' for i in range(1, 6)), newline='\n')
        self.git('add', 'long.txt')
        (self.repo / 'long.txt').write_text('w1\nw2\nw3', newline='\n')
        r = self.file_lines(path='long.txt', rev='worktree', start=2, end=50)
        self.assertEqual(r.status_code, 200, r.text)
        self.assertEqual(r.json(), {'lines': ['w2', 'w3'], 'start': 2, 'end': 3, 'total': 3})
        self.assertEqual(self.file_lines(path='long.txt', rev='index', start=4, end=9).json(),
                         {'lines': ['i4', 'i5'], 'start': 4, 'end': 5, 'total': 5})
        self.assertEqual(self.file_lines(path='long.txt', rev=sha, start=3, end=4).json(),
                         {'lines': ['c3', 'c4'], 'start': 3, 'end': 4, 'total': 10})
        self.assertEqual(self.file_lines(path='long.txt', rev=sha[:10], start=10, end=10).json()['lines'], ['c10'])
        past = self.file_lines(path='long.txt', rev=sha, start=20, end=30).json()
        self.assertEqual((past['lines'], past['total']), ([], 10))
        (self.repo / 'crlf.txt').write_bytes(b'a\r\nb\r\n')
        self.assertEqual(self.file_lines(path='crlf.txt', rev='worktree', start=1, end=2).json()['lines'],
                         ['a\r', 'b\r'])

    def test_file_lines_refusals(self):
        self.config(repos=str(self.repo))
        ok = {'path': 'file.txt', 'rev': 'worktree', 'start': 1, 'end': 1}
        self.assertEqual(self.file_lines(**ok).status_code, 200)
        for path in ['../x', '/etc/passwd', '--x', 'a\x00b', 'a/../../x', '.git/config', 'sub/.git/HEAD', 'C:/x']:
            with self.subTest(path=path):
                self.assertEqual(self.file_lines(**{**ok, 'path': path}).status_code, 400)
        for rev in ['HEAD', '--all', 'main', 'f' * 40, '']:
            with self.subTest(rev=rev):
                self.assertIn(self.file_lines(**{**ok, 'rev': rev}).status_code, (400, 422))
        self.assertEqual(self.file_lines(**{**ok, 'start': 0}).status_code, 422)
        self.assertEqual(self.file_lines(**{**ok, 'start': 5, 'end': 4}).status_code, 400)
        self.assertEqual(self.file_lines(**{**ok, 'start': 1, 'end': gitx.MAX_FILE_LINES}).status_code, 200)
        self.assertEqual(self.file_lines(**{**ok, 'start': 1, 'end': gitx.MAX_FILE_LINES + 1}).status_code, 400)
        for rev in ['worktree', 'index', self.first]:
            with self.subTest(missing=rev):
                self.assertEqual(self.file_lines(**{**ok, 'path': 'missing.txt', 'rev': rev}).status_code, 404)
        (self.repo / 'bin.dat').write_bytes(b'abc\x00def\n')
        self.git('add', 'bin.dat')
        for rev in ['worktree', 'index']:
            response = self.file_lines(**{**ok, 'path': 'bin.dat', 'rev': rev})
            self.assertEqual(response.status_code, 400)
            self.assertIn('binary', response.text)
        outside = self.root / 'secret.txt'
        outside.write_text('secret\n', newline='\n')
        (self.repo / 'escape').symlink_to(outside)
        (self.repo / 'linkdir').symlink_to(self.root)
        for path in ['escape', 'linkdir/secret.txt']:
            response = self.file_lines(**{**ok, 'path': path})
            self.assertEqual(response.status_code, 400, response.text)
            self.assertNotIn('secret', response.json()['detail'].replace('secret.txt', ''))
        (self.repo / 'inner').symlink_to('file.txt')
        self.assertEqual(self.file_lines(**{**ok, 'path': 'inner'}).json()['lines'], ['one'])
        self.assertEqual(self.file_lines(**{**ok, 'path': 'subdir_missing/x'}).status_code, 404)
        big = self.repo / 'big.txt'
        big.write_text('x\n' * (gitx.MAX_DIFF_BYTES // 2 + 10), newline='\n')
        self.assertEqual(self.file_lines(**{**ok, 'path': 'big.txt'}).status_code, 400)
        self.git('add', 'big.txt')
        self.assertEqual(self.file_lines(**{**ok, 'path': 'big.txt', 'rev': 'index'}).status_code, 400)
        # A directory at a commit is not a file.
        (self.repo / 'd').mkdir()
        (self.repo / 'd' / 'f').write_text('f\n', newline='\n')
        sha = self.commit('dir')
        self.assertEqual(self.file_lines(**{**ok, 'path': 'd', 'rev': sha}).status_code, 404)
        self.assertEqual(self.file_lines(**{**ok, 'path': 'd', 'rev': 'worktree'}).status_code, 404)

    def git(self, *args, repo=None):
        return subprocess.check_output(['git', '-C', str(repo or self.repo), *args], text=True,
                                       stderr=subprocess.STDOUT).strip()

    def make_repo(self, path):
        path.mkdir(parents=True)
        self.git('init', '-b', 'main', repo=path)
        self.git('config', 'user.name', 'Regression Tester', repo=path)
        self.git('config', 'user.email', 'test@example.invalid', repo=path)
        return path

    def commit(self, subject):
        self.git('add', '--all')
        self.git('commit', '-m', subject)
        return self.git('rev-parse', 'HEAD')

    def config(self, workspace='', repos='', roots=''):
        import yaml
        (self.home / 'config.yaml').write_text(yaml.safe_dump({'terminal': {'cwd': workspace},
            'plugins': {'entries': {'git-review': {'settings': {'repos': repos, 'roots': roots}}}}}), newline='\n')

    def get(self, route, **params):
        return self.client.get('/api/plugins/git-review/' + route, params=params)

    def inventory(self, cwd=''):
        response = self.get('worktrees', cwd=cwd)
        self.assertEqual(response.status_code, 200, response.text)
        paths = [r['path'] for r in response.json()['worktrees']]
        self.assertIn(posix(self.repo), [posix(p) for p in paths])
        for path in paths:
            response = self.get('meta', repo=path, cwd=cwd)
            self.assertEqual(response.status_code, 200, response.text)
        return paths

    def test_focused_workspace_recursion_authorization(self):
        self.config(workspace=str(self.root / 'workspace'))
        self.inventory(str(self.root / 'workspace'))

    def test_caller_cwd_cannot_authorize_arbitrary_repository(self):
        self.config()
        with patch.object(gitx, 'session_cwds', return_value=[]), \
                patch.object(select_store, 'latest', return_value=None):
            for cwd in [str(self.repo), str(self.root / 'workspace')]:
                with self.subTest(cwd=cwd):
                    for route in ['meta', 'status', 'commits', 'pr', 'diff']:
                        response = self.get(route, repo=str(self.repo), cwd=cwd)
                        self.assertEqual(response.status_code, 403, response.text)
                    self.assertEqual(self.get('worktrees', cwd=cwd).json()['worktrees'], [])

    def test_caller_cwd_cannot_expand_configured_repository_scope(self):
        self.config(repos=str(self.repo))
        other = self.make_repo(self.root / 'arbitrary')
        self.assertEqual(self.get('meta', repo=str(other), cwd=str(other)).status_code, 403)
        self.assertEqual(self.get('meta', repo=str(self.repo), cwd=str(other)).status_code, 200)
        self.assertNotIn(posix(other), [posix(p) for p in self.inventory(str(other))])

    def test_http_selected_commits_supports_50_and_200_full_shas(self):
        self.config(repos=str(self.repo))
        tree = self.git('rev-parse', 'HEAD^{tree}')
        shas = [self.first]
        for i in range(200):
            shas.append(self.git('commit-tree', tree, '-p', shas[-1], '-m', f'commit {i}'))
        self.git('update-ref', 'refs/heads/main', shas[-1])
        for count in [50, 200]:
            with self.subTest(count=count):
                selected = shas[-count:][::-1]
                response = self.get('diff', repo=str(self.repo), scope='commits', ref=','.join(selected))
                self.assertEqual(response.status_code, 200, response.text)
                self.assertEqual([item['sha'] for item in response.json()['commits']], selected)
        history = self.get('commits', repo=str(self.repo)).json()
        self.assertEqual(len(history['commits']), 200)
        self.assertTrue(history['truncated'])
        self.assertIn('older history', history['note'])
        response = self.get('diff', repo=str(self.repo), scope='commits')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(len(response.json()['commits']), 200)
        self.assertEqual(response.json()['note'], history['note'])
        self.assertEqual(self.get('diff', repo=str(self.repo), scope='commits',
                                  ref=','.join(shas)).status_code, 422)

    def test_profile_workspace_recursion_authorization(self):
        self.config(workspace=str(self.root / 'workspace'))
        self.inventory()

    def test_configured_repos_directory_recursion(self):
        self.config(repos=str(self.root / 'workspace'))
        self.inventory()

    def test_configured_roots_recursion(self):
        self.config(roots=str(self.root / 'workspace'))
        self.inventory()

    def test_session_workspace_inventory_authorization(self):
        with closing(sqlite3.connect(self.home / 'state.db', isolation_level=None)) as db:
            db.execute('CREATE TABLE sessions(cwd TEXT)')
            db.execute('INSERT INTO sessions VALUES (?)', (str(self.root / 'workspace'),))
        self.inventory()

    def test_session_workspace_change_follows_trusted_state(self):
        self.config()
        other = self.make_repo(self.root / 'next-workspace')
        with closing(sqlite3.connect(self.home / 'state.db', isolation_level=None)) as db:
            db.execute('CREATE TABLE sessions(cwd TEXT)')
            db.execute('INSERT INTO sessions VALUES (?)', (str(self.repo),))
            self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 200)
            self.assertEqual(self.get('meta', repo=str(other), cwd=str(other)).status_code, 403)
            db.execute('UPDATE sessions SET cwd = ?', (str(other),))
            self.assertEqual(self.get('meta', repo=str(other), cwd=str(other)).status_code, 200)
            self.assertEqual(self.get('meta', repo=str(self.repo), cwd=str(self.repo)).status_code, 403)
            self.assertEqual([posix(item['path']) for item in self.get('worktrees', cwd=str(other)).json()['worktrees']],
                             [posix(other)])

    @unittest.skipIf(os.name == 'nt', "'?' is invalid in Windows filenames")
    def test_session_database_special_uri_characters(self):
        path = self.root / 'state?#.db'
        with closing(sqlite3.connect(path, isolation_level=None)) as db:
            db.execute('CREATE TABLE sessions(cwd TEXT)')
            db.execute('INSERT INTO sessions VALUES (?)', (str(self.repo),))
        self.assertEqual(gitx.session_cwds(path), [str(self.repo)])

    def test_discovery_depth_skip_dedup(self):
        deep = self.make_repo(self.root / 'workspace' / 'a' / 'b' / 'deep')
        skipped = self.make_repo(self.root / 'workspace' / 'node_modules' / 'hidden')
        discovered = [posix(p) for p in gitx.discover(self.root / 'workspace')]
        self.assertIn(posix(self.repo), discovered)
        self.assertNotIn(posix(deep), discovered)
        self.assertNotIn(posix(skipped), discovered)
        self.assertEqual(gitx.discover(self.repo / '.git'), [])
        self.config(repos=str(self.repo), roots=str(self.root / 'workspace'))
        self.assertEqual([posix(p) for p in self.inventory()].count(posix(self.repo)), 1)

    def test_inventory_does_not_spawn_git_per_directory(self):
        for i in range(20):
            (self.root / 'workspace' / f'plain-{i}').mkdir()
        self.config(roots=str(self.root / 'workspace'))
        api._allowed_cache.clear()
        with patch.object(gitx, '_capture', wraps=gitx._capture) as capture:
            response = self.get('worktrees')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn(posix(self.repo), [posix(w['path']) for w in response.json()['worktrees']])
        self.assertLessEqual(capture.call_count, 2, [c.args[0][:4] for c in capture.call_args_list])

    def test_profile_change_revokes_authorization(self):
        self.config(repos=str(self.repo))
        self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 200)
        other = self.root / 'other'
        other.mkdir()
        with patch.dict(os.environ, {'HERMES_HOME': str(other)}):
            self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 403)

    def test_config_change_revokes_authorization(self):
        self.config(repos=str(self.repo))
        self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 200)
        self.config()
        self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 403)

    def test_unknown_and_relative_repository_refused(self):
        self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 403)
        self.assertEqual(self.get('meta', repo='relative').status_code, 400)

    def test_whitespace_all_relevant_scopes(self):
        (self.repo / 'file.txt').write_text('one  \ntwo\n', newline='\n')
        self.assertTrue(gitx.diff(self.repo, 'uncommitted')['patch'])
        self.assertEqual(gitx.diff(self.repo, 'uncommitted', ignore_ws=True)['patch'], '')
        self.git('add', 'file.txt')
        self.assertEqual(gitx.diff(self.repo, 'staged', ignore_ws=True)['patch'], '')
        sha = self.commit('whitespace')
        self.assertEqual(gitx.diff(self.repo, 'commits', ref=sha, ignore_ws=True)['commits'][0]['patch'], '')

    def test_root_patch_consistency(self):
        multi = gitx.diff(self.repo, 'commits', ref=self.first, ignore_ws=True)['commits'][0]
        self.assertEqual(multi['added'], 2)

    def test_context_is_foldable_and_bounded(self):
        (self.repo / 'file.txt').write_text(''.join(f'line {i}\n' for i in range(160)), newline='\n')
        self.commit('long')
        lines = (self.repo / 'file.txt').read_text().splitlines(True)
        lines[80] = 'changed\n'
        (self.repo / 'file.txt').write_text(''.join(lines), newline='\n')
        result = gitx.diff(self.repo, 'uncommitted')
        context = [l for l in result['patch'].splitlines() if l.startswith(' ')]
        self.assertEqual(len(context), 2 * gitx.DIFF_CONTEXT_LINES)
        self.assertEqual((result['added'], result['removed']), (1, 1))

    def test_all_commits_default_explicit_base(self):
        (self.repo / 'file.txt').write_text('three\n', newline='\n')
        sha = self.commit('second')
        self.assertEqual([c['sha'] for c in gitx.commits(self.repo)['commits']], [sha, self.first])
        self.assertEqual([c['sha'] for c in gitx.commits(self.repo, self.first)['commits']], [sha])
        self.assertEqual(len(gitx.diff(self.repo, 'commits')['commits']), 2)

    def test_noncontiguous_commits_truthful_separate_patches(self):
        (self.repo / 'file.txt').write_text('selected\n', newline='\n')
        second = self.commit('selected')
        (self.repo / 'unselected.txt').write_text('must not leak\n', newline='\n')
        self.commit('unselected')
        (self.repo / 'file.txt').write_text('final\n', newline='\n')
        fourth = self.commit('final')
        result = gitx.diff(self.repo, 'commits', ref=f'{fourth},{second},{second}')
        self.assertEqual([c['sha'] for c in result['commits']], [fourth, second])
        self.assertTrue(all('unselected.txt' not in c['patch'] for c in result['commits']))
        self.assertIn('-selected', result['commits'][0]['patch'])
        self.assertIn('+selected', result['commits'][1]['patch'])
        self.assertNotIn('patch', result)

    def test_injection_and_literal_glob(self):
        for ref in ['--output=x', 'HEAD;touch x', 'main..HEAD', 'HEAD^{tree}', 'HEAD\n--all']:
            with self.subTest(ref=ref), self.assertRaises(gitx.GitError):
                gitx.diff(self.repo, 'commits', ref=ref)
        for path in ['../file.txt', '/etc/passwd', '--output=x', 'a\x00b']:
            with self.subTest(path=path), self.assertRaises(gitx.GitError):
                gitx.diff(self.repo, 'uncommitted', path=path)
    @unittest.skipIf(os.name == 'nt', 'wildcards are invalid in Windows filenames')
    def test_literal_glob_pathspec_is_not_expanded(self):
        for name in ['literal*.txt', 'literal-other.txt']:
            (self.repo / name).write_text('before\n', newline='\n')
        self.commit('literal')
        for name in ['literal*.txt', 'literal-other.txt']:
            (self.repo / name).write_text('after\n', newline='\n')
        result = gitx.diff(self.repo, 'uncommitted', path='literal*.txt')
        self.assertIn('literal*.txt', result['patch'])
        self.assertNotIn('literal-other.txt', result['patch'])

    def test_summary_header_like_content(self):
        (self.repo / 'file.txt').write_text('--old\n', newline='\n')
        self.commit('old')
        (self.repo / 'file.txt').write_text('++new\n', newline='\n')
        result = gitx.diff(self.repo, 'uncommitted')
        self.assertEqual((result['added'], result['removed']), (1, 1))

    def test_read_only_diff_no_checkout(self):
        self.git('branch', 'feature')
        (self.repo / 'file.txt').write_text('working\n', newline='\n')
        before = (self.git('symbolic-ref', 'HEAD'), self.git('status', '--porcelain'),
                  (self.repo / '.git' / 'index').read_bytes())
        gitx.diff(self.repo, 'uncommitted')
        gitx.diff(self.repo, 'commits')
        after = (self.git('symbolic-ref', 'HEAD'), self.git('status', '--porcelain'),
                 (self.repo / '.git' / 'index').read_bytes())
        self.assertEqual(before, after)
        self.assertEqual(self.get('checkout', repo=str(self.repo)).status_code, 404)

    def test_selection_cross_process_route_authorization(self):
        result = select_tool.handle(repo=str(self.repo), scope='commits', ignore_ws=True)
        self.assertTrue(result['ok'], result)
        selected = self.get('pending-select', after=0).json()['request']
        self.assertEqual(selected['id'], result['request_id'])
        self.assertTrue(selected['ignore_ws'])
        self.assertEqual(self.get('pending-select', after=selected['id']).json(), {'request': None})
        self.inventory()
        source = Path(gitx.__file__).resolve().parents[1]
        raw = subprocess.check_output([sys.executable, '-c',
            'from git_review.select_store import latest; import json; print(json.dumps(latest()))'],
            cwd=source, text=True)
        self.assertEqual(json.loads(raw)['id'], selected['id'])

    def test_tool_default_commit_invalid_does_not_push(self):
        self.assertTrue(select_tool.handle(repo=str(self.repo), scope='uncommitted')['ok'])
        before = select_store.latest()['id']
        self.assertFalse(select_tool.handle(repo=str(self.repo), scope='range', ref='--bad')['ok'])
        self.assertEqual(select_store.latest()['id'], before)

    def test_sqlite_retention_ids_profile_isolation(self):
        ids = [select_store.push(str(self.repo), 'uncommitted', ref=self.first) for _ in range(25)]
        self.assertEqual(len(set(ids)), 25)
        with select_store.connect() as db:
            self.assertEqual(db.execute('SELECT COUNT(*) FROM pending_select').fetchone()[0], 20)
        with patch.dict(os.environ, {'HERMES_HOME': str(self.root / 'other')}):
            self.assertIsNone(select_store.latest())

    def test_pr_badge_open_state_args_validation(self):
        self.git('remote', 'add', 'origin', 'git@gitlab.example:org/repo.git')
        data = json.dumps([{'state': 'opened', 'web_url': 'https://gitlab.example/o/r/-/merge_requests/4',
                           'iid': 4, 'title': 'Review me'}])
        with patch.object(gitx, '_run_tool', return_value=data) as tool:
            self.assertEqual(gitx.pr_for_branch(self.repo, 'main')['iid'], 4)
            self.assertNotIn('--all', tool.call_args.args[0])
            self.assertIn('--source-branch', tool.call_args.args[0])
        with self.assertRaises(gitx.GitError):
            gitx.pr_for_branch(self.repo, '--bad')
        with self.assertRaises(gitx.GitError):
            gitx._first_pr('[{"state":"closed"}]', 'gh')
        self.assertEqual(gitx._first_pr('[{"state":"OPEN","number":2,"url":"https://github.com/a/b/pull/2"}]', 'gh')['iid'], 2)

    def test_pr_environment_preserves_auth_names(self):
        with patch.dict(os.environ, {'GH_TOKEN': 'test-placeholder', 'GLAB_CONFIG_DIR': '/example'}), \
                patch.object(gitx, '_capture', return_value='[]') as capture:
            gitx._run_tool(['gh', 'pr', 'list'], cwd=self.repo)
            self.assertIn('GH_TOKEN', capture.call_args.kwargs['env'])
            self.assertIn('GLAB_CONFIG_DIR', capture.call_args.kwargs['env'])

    def test_large_diff_refused_not_partial(self):
        (self.repo / 'file.txt').write_text('x' * (gitx.MAX_DIFF_BYTES + 70000), newline='\n')
        result = gitx.diff(self.repo, 'uncommitted')
        self.assertEqual(result['patch'], '')
        self.assertIn('limit', result['note'])

    def test_capture_timeout_output_limit(self):
        with self.assertRaises(gitx.GitError):
            gitx._capture([sys.executable, '-c', 'import time; time.sleep(1)'], timeout=0.05)
        with self.assertRaises(gitx.OutputLimit):
            gitx._capture([sys.executable, '-c', 'print("x"*100000)'], limit=1024)

    def test_loader_router(self):
        path = Path(gitx.__file__).resolve().parents[1] / 'dashboard' / 'plugin_api.py'
        spec = importlib.util.spec_from_file_location('git_review_loader_audit', path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        app = FastAPI()
        app.include_router(module.router, prefix='/api/plugins/git-review')
        with TestClient(app) as client:
            response = client.get('/api/plugins/git-review/worktrees', params={'cwd': str(self.repo)})
        self.assertEqual(response.status_code, 200, response.text)

    def test_history_cap_explicit(self):
        for i in range(3):
            (self.repo / 'file.txt').write_text(f'{i}\n', newline='\n')
            self.commit(f'commit {i}')
        with patch.object(gitx, 'MAX_COMMITS', 2):
            history = gitx.commits(self.repo)
            self.assertEqual(len(history['commits']), 2)
            self.assertTrue(history['truncated'])
            result = gitx.diff(self.repo, 'commits')
            self.assertEqual(len(result['commits']), 2)
            self.assertIn('older history', result['note'])

    def test_merge_counts_match_patch(self):
        self.git('switch', '-c', 'feature')
        (self.repo / 'new.txt').write_text('new\n', newline='\n')
        self.commit('feature')
        self.git('switch', 'main')
        (self.repo / 'main.txt').write_text('main\n', newline='\n')
        self.commit('main')
        self.git('merge', '--no-ff', 'feature', '-m', 'merge')
        sha = self.git('rev-parse', 'HEAD')
        listed = gitx.commits(self.repo)['commits'][0]
        shown = gitx.diff(self.repo, 'commits', ref=sha)['commits'][0]
        self.assertEqual((listed['added'], listed['removed']), (shown['added'], shown['removed']))
        self.assertEqual(listed['added'], 1)

    def test_sha_filename_not_revision_ambiguity(self):
        (self.repo / self.first).write_text('ambiguous\n', newline='\n')
        (self.repo / 'HEAD').write_text('ambiguous\n', newline='\n')
        self.commit('paths')
        self.assertTrue(gitx.diff(self.repo, 'commits', ref=self.first)['commits'][0]['patch'])
        self.assertEqual(len(gitx.commits(self.repo)['commits']), 2)

    def test_http_diff_status_commits_errors(self):
        self.config(repos=str(self.repo))
        (self.repo / 'file.txt').write_text('change\n', newline='\n')
        self.assertEqual(self.get('status', repo=str(self.repo)).json()['files'][0]['status'], 'modified')
        response = self.get('diff', repo=str(self.repo), scope='uncommitted', ignore_ws='true')
        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()['added'], 1)
        self.assertEqual(len(self.get('commits', repo=str(self.repo)).json()['commits']), 1)
        self.assertEqual(self.get('diff', repo=str(self.repo), scope='range', ref='--bad').status_code, 400)
        self.assertEqual(self.get('diff', repo=str(self.repo), scope='bogus').status_code, 400)
        self.assertEqual(self.get('meta', repo=str(self.repo) + '\x00').status_code, 400)
        self.assertEqual(self.get('pending-select', after=-1).status_code, 422)

    def test_malformed_settings_fail_closed(self):
        (self.home / 'config.yaml').write_text('plugins:\n  entries:\n    git-review:\n      settings: [bad]\n', newline='\n')
        self.assertEqual(self.get('worktrees').status_code, 200)
        self.assertEqual(self.get('meta', repo=str(self.repo)).status_code, 403)

    def test_pr_provider_uses_host_not_repo_name(self):
        self.git('remote', 'add', 'origin', 'https://bitbucket.org/team/github.git')
        with patch.object(gitx, '_run_tool') as tool:
            with self.assertRaises(gitx.GitError):
                gitx.pr_for_branch(self.repo, 'main')
            tool.assert_not_called()

    def test_external_diff_textconv_not_executed(self):
        marker = self.root / 'external-was-run'
        helper = self.root / 'external.py'
        helper.write_text('from pathlib import Path\nPath(' + repr(str(marker)) + ').write_text("executed")\n', newline='\n')
        command = '"' + sys.executable + '" "' + str(helper) + '"'
        self.git('config', 'diff.audit.textconv', command)
        self.git('config', 'diff.external', command)
        (self.repo / '.gitattributes').write_text('file.txt diff=audit\n', newline='\n')
        self.commit('attributes')
        (self.repo / 'file.txt').write_text('change\n', newline='\n')
        self.assertTrue(gitx.diff(self.repo, 'uncommitted')['patch'])
        gitx.commits(self.repo)
        gitx.diff(self.repo, 'commits', ref=self.first)
        self.assertFalse(marker.exists())

    def test_unborn_repository_tracked_working_tree_and_history(self):
        self.repo = self.make_repo(self.root / 'unborn')
        (self.repo / 'new.txt').write_text('staged\n', newline='\n')
        self.git('add', 'new.txt')
        (self.repo / 'new.txt').write_text('working\n', newline='\n')
        index = (self.repo / '.git' / 'index').read_bytes()
        result = gitx.diff(self.repo, 'uncommitted')
        self.assertIn('+working', result['patch'])
        self.assertEqual(result['added'], 1)
        self.assertEqual(gitx.commits(self.repo)['commits'], [])
        self.assertIn('no commits', gitx.diff(self.repo, 'commits')['note'])
        self.assertEqual((self.repo / '.git' / 'index').read_bytes(), index)

    def test_empty_ref_tokens_are_not_all_selection(self):
        for ref in [',', self.first + ',']:
            with self.assertRaises(gitx.GitError):
                gitx.diff(self.repo, 'commits', ref=ref)

    def test_arbitrary_commit_from_other_branch(self):
        self.git('switch', '-c', 'other')
        (self.repo / 'other.txt').write_text('other branch\n', newline='\n')
        sha = self.commit('other branch')
        self.git('switch', 'main')
        result = gitx.diff(self.repo, 'commits', ref=sha)
        self.assertIn('+other branch', result['commits'][0]['patch'])
        self.assertEqual(self.git('branch', '--show-current'), 'main')

    def test_pr_malformed_metadata_is_error_not_unsafe_badge(self):
        for item in [{'state': 'OPEN'},
                     {'state': 'OPEN', 'url': 'javascript:bad', 'number': 1},
                     {'state': 'OPEN', 'url': 'https://github.com/a/b/pull/1', 'number': 1, 'title': 42}]:
            with self.assertRaises(gitx.GitError):
                gitx._first_pr(json.dumps([item]), 'gh')

    def test_registration_contract(self):
        ctx = Mock()
        select_tool.register(ctx)
        ctx.register_tool.assert_called_once_with(name='git_review_select', toolset='git',
                                                 schema=select_tool.SCHEMA, handler=select_tool.handle)

if __name__ == '__main__':
    unittest.main()