const tap = require('tap')
const { unlink } = require('fs/promises')

const { mockCore } = require('gh-action-components')
const { TestAutoMerger, serverUrl, runId } = require('./test-helpers')
const { ISSUE_COMMENT_FILENAME } = require('../src/constants')

/**
 * Registers teardown to clean up the temporary issue comment file
 * created by writeComment tests, ensuring cleanup even if assertions fail.
 */
function cleanupIssueCommentFile(t) {
	t.teardown(async () => {
		try {
			await unlink(ISSUE_COMMENT_FILENAME)
		} catch (e) {
			// File may not exist, that's okay
		}
	})
}

process.env.GITHUB_REPOSITORY = 'spiderstrategies/unittest'

tap.test(`generateMergeWarning`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		prNumber: 123,
		core: coreMock
	})
	action.generateMergeConflictWarning()

	const expectedStatus = '<https://github.com/sample/repo/issues/123|PR #123> ' +
		'<https://github.com/sample/repo/1#issuecomment-123xyz|Issue> ' +
		'<https://github.com/sample/repo/actions/runs/1935306317|Action Run>'

	t.equal(action.statusMessage, expectedStatus)
	t.equal(coreMock.warningMsgs.length, 1, 'should have warning')
	t.equal(coreMock.warningMsgs[0], expectedStatus, 'warning should match status message')
})

tap.test(`initialize state`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		prNumber: 123,
		prCommitSha: 'abc123def456',
		pullRequest: { merge_commit_sha: 'abc123' },
		config: { mergeTargets: ['main'] },
		core: coreMock
	})

	await action.initializeState()

	t.equal(action.terminalBranch, 'main')
	t.equal(action.lastSuccessfulMergeRef, 'abc123def456', 'should initialize lastSuccessfulMergeRef to prCommitSha')
	t.ok(coreMock.infoMsgs.some(msg => msg.includes('mergeTargets')))
	t.ok(coreMock.infoMsgs.some(msg => msg.includes('terminal branch')))
})

/**
 *
 */
tap.test(`error status`, async t => {
	const coreMock = mockCore({})
	const action = new TestAutoMerger({
		core: coreMock
	})

	action.core.setFailed('Test error')
	t.equal(coreMock.failedArg, 'Test error')
})

tap.test('createMergeConflictsBranchName encodes source and target branches', async t => {
	let action = new TestAutoMerger({})

	t.test('handles standard branch names', async t => {
		const actual = action.createMergeConflictsBranchName('68586', 'release-5.8.0', 'main')
		t.equal('merge-conflicts-68586-release-5-8-0-to-main', actual)
	})

	t.test('handles branch names without dots', async t => {
		const actual = action.createMergeConflictsBranchName('12345', 'develop', 'main')
		t.equal('merge-conflicts-12345-develop-to-main', actual)
	})

	t.test('handles multiple dots in version numbers', async t => {
		const actual = action.createMergeConflictsBranchName('68590', 'release-5.7.2', 'release-5.8.0')
		t.equal('merge-conflicts-68590-release-5-7-2-to-release-5-8-0', actual)
	})
})

tap.test('createMergeForwardBranchName creates proper branch names', async t => {
	t.test('handles standard branch names', async t => {
		const action = new TestAutoMerger({ prNumber: 123 })
		const actual = action.createMergeForwardBranchName('release-5.8.0')
		t.equal('merge-forward-pr-123-release-5-8-0', actual)
	})

	t.test('handles branch names without dots', async t => {
		const action = new TestAutoMerger({ prNumber: 456 })
		const actual = action.createMergeForwardBranchName('main')
		t.equal('merge-forward-pr-456-main', actual)
	})

	t.test('handles multiple dots in version numbers', async t => {
		const action = new TestAutoMerger({ prNumber: 789 })
		const actual = action.createMergeForwardBranchName('release-5.7.2')
		t.equal('merge-forward-pr-789-release-5-7-2', actual)
	})
})

tap.test('executeMerges', async t => {
	t.test('successful merge to all targets', async t => {
		const execCalls = []
		const gitCalls = []
		const startGroups = []
		const endGroupCount = []
		const core = mockCore({})
		core.startGroup = (msg) => startGroups.push(msg)
		core.endGroup = () => endGroupCount.push(1)

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			},
			async deleteBranch(branch) {
				gitCalls.push(`deleteBranch:${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return true  // Success
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 3, 'should checkout all branches')
		t.equal(gitCalls.find(c => c.includes('deleteBranch:issue-123-my-fix')), 'deleteBranch:issue-123-my-fix', 'should delete PR branch on success')
		t.equal(startGroups.length, 3, 'should start group for each merge')
		t.equal(endGroupCount.length, 3, 'should end group for each merge')
	})

	t.test('stops merging on first conflict', async t => {
		const execCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				// Fail on second branch
				return branch !== 'release-5.8'
			}

			generateMergeConflictWarning() {
				this.warningGenerated = true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})
		action.conflictBranch = 'release-5.8'

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when merge fails')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after failed merge')
		t.equal(action.warningGenerated, true, 'should generate conflict warning')
	})

	t.test('handles merge exception', async t => {
		const execCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const mockGit = {
			async checkout(branch) {
				execCalls.push(`git checkout ${branch}`)
			}
		}

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				if (branch === 'release-5.8') {
					throw new Error('Git merge failed')
				}
				return true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git: mockGit
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when exception occurs')
		t.ok(core.failedArg, 'should call setFailed when exception occurs')
		t.equal(execCalls.filter(c => c.startsWith('git checkout')).length, 2, 'should stop after exception')
	})
})

tap.test('run', async t => {
	t.test('skips when PR not merged', async t => {
		let infoCalled = false
		const core = mockCore({})
		core.info = () => { infoCalled = true }

		const action = new TestAutoMerger({
			pullRequest: {
				merged: false
			},
			core
		})

		await action.run()

		t.ok(infoCalled, 'should log info about skipping')
	})

	t.test('skips when PR against terminal branch', async t => {
		const core = mockCore({})
		const action = new TestAutoMerger({
			pullRequest: {
				merged: true,
				merge_commit_sha: 'abc123'
			},
			config: {
				mergeTargets: ['main']
			},
			core
		})
		action.terminalBranch = null

		await action.initializeState()

		t.equal(action.terminalBranch, 'main')
	})
})

tap.test('handleConflicts', async t => {
	t.test('creates issue and merge-conflicts branch when conflicts detected', async t => {
		const core = mockCore({})
		const shellCommands = []
		const gitCommands = []
		let issueCreated = false

		const mockShell = {
			async exec(cmd) {
				shellCommands.push(cmd)
				if (cmd.startsWith('git diff --name-only')) {
					return 'src/file1.js\nsrc/file2.js'
				}
				return ''
			}
		}

		const mockGit = {
			async reset(branch, flag) {
				gitCommands.push(`reset ${branch} ${flag}`)
			},
			async createBranch(branchName, sha) {
				gitCommands.push(`createBranch ${branchName} ${sha}`)
			}
		}

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async createIssue(options) {
				issueCreated = true
				t.equal(options.title, 'Merge #12345 (abc123456) into release-5.8', 'should have correct title')
				t.ok(options.labels.includes('merge conflict'), 'should include merge conflict label')
				t.ok(options.labels.includes('highest priority'), 'should include highest priority label')
				t.equal(options.milestone, 23, 'should use milestone from config')
				return { data: { number: 68586, html_url: 'https://github.com/sample/repo/issues/68586' } }
			},
			async fetchCommits() {
				return {
					data: [{
						commit: {
							author: { name: 'Test', email: 'test@example.com' },
							message: 'Test commit'
						}
					}]
				}
			}
		}

		const action = new TestAutoMerger({
			prNumber: 999,
			prAuthor: 'testdev',
			prCommitSha: 'abc123456789',
			baseBranch: 'release-5.7',
			config: {
				branches: {
					'release-5.8': { milestoneNumber: 23 }
				},
				getBranchAlias: (branch) => branch
			},
			core,
			shell: mockShell,
			git: mockGit,
			gh: mockGh,
			conflictBranch: null
		})
		action.issueNumber = 12345

		await action.handleConflicts('release-5.8')

		t.ok(issueCreated, 'should create GitHub issue')
		t.equal(action.conflictBranch, 'release-5.8', 'should set conflictBranch')
		t.ok(gitCommands.find(c => c.includes('reset release-5.8 --hard')), 'should reset branch')
		t.ok(gitCommands.find(c => c.includes('createBranch merge-conflicts-68586-release-5-7-to-release-5-8 abc123456789')),
			'should create merge-conflicts branch with encoded name')
		// Note: IssueResolver.resolveIssues() is tested separately in issue-resolver-test.js
	})

	t.test('skips when no conflicts found', async t => {
		const core = mockCore({})
		const gitCommands = []

		const mockShell = {
			async exec(cmd) {
				if (cmd.startsWith('git diff --name-only')) {
					return ''  // No conflicts
				}
				return ''
			}
		}

		const mockGit = {
			async reset(branch, flag) {
				gitCommands.push(`reset ${branch} ${flag}`)
			}
		}

		const action = new TestAutoMerger({
			core,
			shell: mockShell,
			git: mockGit,
			conflictBranch: null
		})

		await action.handleConflicts('release-5.8')

		t.equal(gitCommands.length, 0, 'should not call git reset when no conflicts')
		t.notOk(action.conflictBranch, 'should not set conflictBranch when no conflicts')
	})
})

tap.test('createIssue', async t => {
	t.test('creates issue with proper metadata and assigns to PR author', async t => {
		const core = mockCore({})
		const shellCommands = []
		let createdIssue

		const mockShell = {
			async exec(cmd) {
				shellCommands.push(cmd)
				return ''
			}
		}

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async createIssue(options) {
				createdIssue = options
				return {
					data: {
						number: 99999,
						html_url: 'https://github.com/sample/repo/issues/99999'
					}
				}
			}
		}

		const action = new TestAutoMerger({
			prNumber: 555,
			prAuthor: 'johndoe',
			prCommitSha: 'def456789abc',
			config: {
				branches: {
					'main': { milestoneNumber: 42 }
				},
				getBranchAlias: () => 'Main'
			},
			core,
			shell: mockShell,
			gh: mockGh
		})
		action.issueNumber = 888

		const newIssueNumber = await action.createIssue({
			branch: 'main',
			conflicts: 'file1.js\nfile2.js'
		})

		t.equal(newIssueNumber, 99999, 'should return new issue number')
		t.equal(createdIssue.title, 'Merge #888 (def456789) into main', 'should include issue number and short sha in title')
		t.ok(createdIssue.labels.includes('merge conflict'), 'should have merge conflict label')
		t.ok(createdIssue.labels.includes('highest priority'), 'should have highest priority label')
		t.equal(createdIssue.milestone, 42, 'should use milestone from config')

		const editCommand = shellCommands.find(cmd => cmd.includes('gh issue edit'))
		t.ok(editCommand, 'should edit issue to add body and assignee')
		t.ok(editCommand.includes('--add-assignee "johndoe"'), 'should assign to PR author')
		t.equal(action.issueUrl, 'https://github.com/sample/repo/issues/99999', 'should set issueUrl')
	})

	t.test('handles missing milestone gracefully', async t => {
		const core = mockCore({})
		let createdIssue

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async createIssue(options) {
				createdIssue = options
				return { data: { number: 777, html_url: 'https://github.com/sample/repo/issues/777' } }
			}
		}

		const action = new TestAutoMerger({
			config: {
				branches: {
					'release-5.9': {}  // No milestone
				},
				getBranchAlias: () => '5.9'
			},
			core,
			shell: { async exec() { return '' } },
			gh: mockGh
		})

		await action.createIssue({ branch: 'release-5.9', conflicts: 'file.js' })

		t.equal(createdIssue.milestone, undefined, 'should handle missing milestone')
	})
})

tap.test('writeComment', async t => {
	t.test('generates complete conflict resolution instructions', async t => {
		const core = mockCore({})
		const { readFile } = require('fs/promises')

		const action = new TestAutoMerger({
			prNumber: 12345,
			prAuthor: 'bobsmith',
			prCommitSha: 'xyz789abc123',
			baseBranch: 'release-5.7',
			config: {
				mergeTargets: ['release-5.8', 'main'],
				getBranchAlias: (branch) => branch === 'release-5.8' ? '5.8' : 'main'
			},
			core
		})
		action.issueNumber = 54321
		action.terminalBranch = 'main'
		action.actionUrl = 'https://github.com/sample/repo/actions/runs/123456'

		const filename = await action.writeComment({
			branch: 'release-5.8',
			issueNumber: 54321,
			conflicts: 'src/app.js\nsrc/config.js',
			conflictIssueNumber: 99999,
			conflictBranchName: 'merge-conflicts-99999-release-5-7-to-release-5-8'
		})

		cleanupIssueCommentFile(t)

		t.equal(filename, ISSUE_COMMENT_FILENAME, 'should return filename')

		const content = await readFile(filename, 'utf-8')

		t.ok(content.includes('## Automatic Merge Failed'), 'should have failure header')
		t.ok(content.includes('@bobsmith'), 'should mention PR author')
		t.ok(content.includes('pull request #12345'), 'should reference original PR')
		t.ok(content.includes('for issue #54321'), 'should reference issue number')
		t.ok(content.includes('`release-5.8`'), 'should mention target branch')
		t.ok(content.includes('git fetch'), 'should include git fetch command')
		t.ok(content.includes('merge-conflicts-99999-release-5-7-to-release-5-8'), 'should use merge-conflicts branch name')
		t.ok(content.includes('git merge release-5.8'), 'should merge the target branch, not the commit SHA')
		t.notOk(content.includes('git merge xyz789abc123'), 'should not merge the commit SHA directly')
		t.ok(content.includes('Fixes #99999'), 'should include Fixes keyword for new issue')
		t.ok(content.includes('- src/app.js'), 'should list first conflict file')
		t.ok(content.includes('- src/config.js'), 'should list second conflict file')
		t.notOk(content.includes('origin/branch-here-release-5.8'), 'should not use branch-here since working on existing merge-conflicts branch')
	})

	t.test('uses merge-conflicts branch directly', async t => {
		const core = mockCore({})
		const { readFile } = require('fs/promises')

		const action = new TestAutoMerger({
			prCommitSha: 'abc123',
			config: {
				getBranchAlias: () => 'main'
			},
			core
		})
		action.terminalBranch = 'main'

		const filename = await action.writeComment({
			branch: 'main',
			issueNumber: 222,
			conflicts: 'file.js',
			conflictIssueNumber: 333,
			conflictBranchName: 'merge-conflicts-333-release-5-8-0-to-main'
		})

		cleanupIssueCommentFile(t)

		const content = await readFile(filename, 'utf-8')

		t.ok(content.includes('merge-conflicts-333-release-5-8-0-to-main'), 'should use merge-conflicts branch')
		t.notOk(content.includes('branch-here'), 'should not reference branch-here when using existing merge-conflicts branch')
	})

	t.test('handles missing issue number in PR', async t => {
		const core = mockCore({})
		const { readFile } = require('fs/promises')

		const action = new TestAutoMerger({
			prNumber: 777,
			prCommitSha: 'sha123',
			config: {
				getBranchAlias: () => 'release'
			},
			core
		})
		action.terminalBranch = 'main'

		const filename = await action.writeComment({
			branch: 'release',
			issueNumber: null,  // No issue linked to PR
			conflicts: 'test.js',
			conflictIssueNumber: 888,
			conflictBranchName: 'merge-conflicts-888-release-5-7-0-to-release'
		})

		cleanupIssueCommentFile(t)

		const content = await readFile(filename, 'utf-8')

		t.ok(content.includes('pull request #777'), 'should still reference PR')
		t.notOk(content.includes('for issue #'), 'should not mention issue when none exists')
		t.ok(content.includes('merge-conflicts-888-release-5-7-0-to-release'), 'should use merge-conflicts branch name')
	})

	t.test('branch name uses conflict issue number, not original PR issue', async t => {
		const core = mockCore({})
		const { readFile } = require('fs/promises')

		const action = new TestAutoMerger({
			prNumber: 12345,
			prAuthor: 'testuser',
			prCommitSha: 'abc123',
			config: {
				getBranchAlias: () => '5.8.0'
			},
			core
		})
		action.terminalBranch = 'main'

		const filename = await action.writeComment({
			branch: 'release-5.8.0',
			issueNumber: 99999,  // Original PR was fixing issue #99999
			conflicts: 'file.js',
			conflictIssueNumber: 11111,  // New conflict issue
			conflictBranchName: 'merge-conflicts-11111-release-5-7-2-to-release-5-8-0'
		})

		cleanupIssueCommentFile(t)

		const content = await readFile(filename, 'utf-8')

		t.ok(content.includes('merge-conflicts-11111-release-5-7-2-to-release-5-8-0'),
			'should use merge-conflicts branch name')
		t.notOk(content.includes('issue-11111-pr-12345'),
			'should not use old issue-* branch naming scheme')
		t.notOk(content.includes('issue-99999-pr-12345'),
			'should not use original PR issue number (99999)')
	})
})

tap.test('merge', async t => {
	t.test('handles already merged case', async t => {
		const execCalls = []
		const core = mockCore({})

		const mockGit = {
			async pull() {
				execCalls.push('git pull')
			},
			async merge(sha, options) {
				execCalls.push(`git merge ${sha}`)
				return 'Already up to date.'
			},
			async commit(message, author) {
				execCalls.push('git commit')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: {
				head: { sha: 'abc123' }
			},
			baseBranch: 'release-5.7',
			prNumber: 456,
			prBranch: 'my-feature',
			core,
			git: mockGit
		})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true even when already merged')
		t.ok(execCalls.find(c => c.includes('git pull')), 'should pull before merging')
		t.ok(execCalls.find(c => c.includes('git merge abc123')), 'should attempt merge')
		t.notOk(execCalls.find(c => c.includes('git commit')), 'should not commit when already merged')
	})

	t.test('successful merge creates commit and merge-forward branch', async t => {
		let commitCalled = false
		const core = mockCore({})
		const shellCommands = []
		const gitCommands = []

		const mockShell = {
			async exec(cmd) {
				shellCommands.push(cmd)
				if (cmd === 'git rev-parse HEAD') {
					return 'newMergeCommit789'
				}
				return ''
			}
		}

		const mockGit = {
			async pull() {},
			async merge(sha, options) {
				return 'Merge made by strategy'
			},
			async commit(message, author) {
				commitCalled = true
				t.ok(author, 'should pass author to commit')
				t.equal(author.name, 'Test', 'should use correct author name')
			},
			async createBranch(branchName, ref) {
				gitCommands.push(`createBranch:${branchName}:${ref}`)
			},
			async push(options) {
				gitCommands.push(`push:${options}`)
			}
		}

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async fetchCommits(prNum) {
				return {
					data: [{
						commit: {
							author: { name: 'Test', email: 'test@example.com' }
						}
					}]
				}
			}
		}

		const action = new TestAutoMerger({
			pullRequest: {
				head: { sha: 'def456' }
			},
			baseBranch: 'release-5.7',
			prNumber: 789,
			prBranch: 'my-feature',
			core,
			shell: mockShell,
			git: mockGit,
			gh: mockGh
		})

		action.lastSuccessfulMergeRef = 'originalCommit123'

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true on success')
		t.ok(commitCalled, 'should create commit when merge successful')
		t.equal(action.lastSuccessfulMergeRef, 'newMergeCommit789', 'should update lastSuccessfulMergeRef to new merge commit')

		// Verify merge-forward branch creation
		const createBranchCmd = gitCommands.find(c => c.startsWith('createBranch:merge-forward-pr-789-release-5-8'))
		t.ok(createBranchCmd, 'should create merge-forward branch')
		t.ok(createBranchCmd.includes(':newMergeCommit789'), 'merge-forward branch should point to merge commit')

		const pushCmd = gitCommands.find(c => c.startsWith('push:'))
		t.ok(pushCmd, 'should push merge-forward branch')
	})

	t.test('handles conflicts', async t => {
		let conflictsHandled = false
		const core = mockCore({})

		const mockGit = {
			async pull() {},
			async merge(sha, options) {
				throw new Error('Merge conflict')
			}
		}

		class TestAction extends TestAutoMerger {
			async handleConflicts(branch) {
				conflictsHandled = true
			}
		}

		const action = new TestAction({
			pullRequest: {
				head: { sha: 'ghi789' }
			},
			baseBranch: 'release-5.7',
			prNumber: 999,
			prBranch: 'my-feature',
			core,
			git: mockGit
		})

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, false, 'should return false when conflicts occur')
		t.ok(conflictsHandled, 'should call handleConflicts')
	})
})
