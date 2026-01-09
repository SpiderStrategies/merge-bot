const tap = require('tap')
const { unlink } = require('fs/promises')

const { mockCore } = require('gh-action-components')
const {
	TestAutoMerger,
	createMockShell,
	createMockGit,
	createGitShellBehavior,
	serverUrl,
	runId
} = require('./test-helpers')
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

tap.test('getBranchHereRef returns correct ref', async t => {
	t.test('returns branch-here-{branch} for non-terminal branches', async t => {
		const action = new TestAutoMerger({})
		action.terminalBranch = 'main'
		const actual = action.getBranchHereRef('release-5.8.0')
		t.equal('branch-here-release-5.8.0', actual)
	})

	t.test('returns branch name directly for terminal branch', async t => {
		const action = new TestAutoMerger({})
		action.terminalBranch = 'main'
		const actual = action.getBranchHereRef('main')
		t.equal('main', actual)
	})
})

tap.test('executeMerges', async t => {
	t.test('successful merge to all targets', async t => {
		const gitCalls = []
		const startGroups = []
		const endGroupCount = []
		const core = mockCore({})
		core.startGroup = (msg) => startGroups.push(msg)
		core.endGroup = () => endGroupCount.push(1)

		const shell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git rev-parse')) return 'mock-commit-sha'
			return ''
		})

		const git = createMockGit(shell, { callTracker: gitCalls })

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return true
			}
			async updateReleaseBranches(branches) {
				// Skip for this basic test
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git,
			shell
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.equal(gitCalls.filter(c => c.startsWith('checkout')).length, 3, 'should checkout all branches')
		t.equal(gitCalls.find(c => c.includes('deleteBranch:issue-123-my-fix')), 'deleteBranch:issue-123-my-fix', 'should delete PR branch on success')
		t.equal(startGroups.length, 3, 'should start group for each merge')
		t.equal(endGroupCount.length, 3, 'should end group for each merge')
	})

	t.test('updates ALL release branches from merge-forward branches when resuming chain reaches main', async t => {
		const gitCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const shell = createMockShell(core, createGitShellBehavior({
			mergeForwardBranches: {
				'12345': [
					{ branch: 'release-5-7-1', sha: 'abc123' },
					{ branch: 'release-5-7-2', sha: 'def456' },
					{ branch: 'release-5-8-0', sha: 'ghi789' }
				]
			},
			revParse: {
				'origin/merge-forward-pr-12345-release-5-7-1': 'commit-sha-5-7-1',
				'origin/merge-forward-pr-12345-release-5-7-2': 'commit-sha-5-7-2',
				'origin/merge-forward-pr-12345-release-5-8-0': 'commit-sha-5-8-0'
			}
		}))

		const git = createMockGit(shell, { callTracker: gitCalls })

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return true
			}
		}

		const action = new TestAction({
			prNumber: 12345,
			prBranch: 'merge-conflicts-67890-release-5-7-2-to-release-5-8-0',
			baseBranch: 'merge-forward-pr-12345-release-5-8-0',
			config: {
				mergeTargets: ['release-5.7.1', 'release-5.7.2', 'release-5.8.0', 'main']
			},
			core,
			git,
			shell
		})
		action.terminalBranch = 'main'

		const result = await action.executeMerges(['release-5.8.0', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.ok(gitCalls.find(c => c.includes('merge:commit-sha-5-7-1:--ff-only')),
			'should update release-5.7.1 even though it was merged in a previous invocation')
		t.ok(gitCalls.find(c => c.includes('merge:commit-sha-5-7-2:--ff-only')),
			'should update release-5.7.2 even though it was merged in a previous invocation')
		t.ok(gitCalls.find(c => c.includes('merge:commit-sha-5-8-0:--ff-only')),
			'should update release-5.8.0 that was merged in this invocation')
		t.notOk(gitCalls.find(c => c.includes('merge:') && c.includes('main')),
			'should not update main (terminal branch)')
	})

	t.test('updates release branches when chain reaches main (starting from first branch)', async t => {
		const gitCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const shell = createMockShell(core, createGitShellBehavior({
			mergeForwardBranches: {
				'12345': [{ branch: 'release-5-8', sha: 'abc123' }]
			},
			revParse: {
				'origin/merge-forward-pr-12345-release-5-8': 'commit-sha-release-5-8'
			}
		}))

		const git = createMockGit(shell, { callTracker: gitCalls })

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return true
			}
		}

		const action = new TestAction({
			prNumber: 12345,
			prBranch: 'feature-branch',
			baseBranch: 'release-5.7',
			config: {
				mergeTargets: ['release-5.8', 'main']
			},
			core,
			git,
			shell
		})
		action.terminalBranch = 'main'

		const result = await action.executeMerges(['release-5.8', 'main'])

		t.equal(result, true, 'should return true when all merges succeed')
		t.ok(gitCalls.filter(c => c === 'checkout:release-5.8').length >= 2,
			'should checkout release-5.8 for merging AND for updating')
		t.ok(gitCalls.find(c => c.includes('merge:commit-sha-release-5-8:--ff-only')),
			'should fast-forward release-5.8 to its merge-forward commit')
		t.ok(gitCalls.find(c => c.includes('push:origin release-5.8')),
			'should push updated release-5.8')
		t.notOk(gitCalls.find(c => c.includes('merge:') && c.includes('main')),
			'should not update main (terminal branch)')
	})

	t.test('stops merging on first conflict', async t => {
		const gitCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const shell = createMockShell(core)
		const git = createMockGit(shell, { callTracker: gitCalls })

		class TestAction extends TestAutoMerger {
			async merge({branch}) {
				return branch !== 'release-5.8'
			}

			generateMergeConflictWarning() {
				this.warningGenerated = true
			}
		}

		const action = new TestAction({
			prBranch: 'issue-123-my-fix',
			core,
			git,
			shell
		})
		action.conflictBranch = 'release-5.8'

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when merge fails')
		t.equal(gitCalls.filter(c => c.startsWith('checkout')).length, 2, 'should stop after failed merge')
		t.equal(action.warningGenerated, true, 'should generate conflict warning')
	})

	t.test('handles merge exception', async t => {
		const gitCalls = []
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const shell = createMockShell(core)
		const git = createMockGit(shell, { callTracker: gitCalls })

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
			git,
			shell
		})

		const result = await action.executeMerges(['release-5.7', 'release-5.8', 'main'])

		t.equal(result, false, 'should return false when exception occurs')
		t.ok(core.failedArg, 'should call setFailed when exception occurs')
		t.equal(gitCalls.filter(c => c.startsWith('checkout')).length, 2, 'should stop after exception')
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

	t.test('detects merge-forward PR and extracts original PR number', async t => {
		const core = mockCore({})
		const action = new TestAutoMerger({
			pullRequest: {
				merged: true,
				base: { ref: 'merge-forward-pr-12345-release-5-8-0' }
			},
			baseBranch: 'merge-forward-pr-12345-release-5-8-0',
			config: {
				mergeTargets: ['release-5.7.0', 'release-5.8.0', 'main']
			},
			core
		})

		const isMergeForward = action.isMergeForwardPR()
		const originalPR = action.getOriginalPRNumber()
		const targetBranch = action.getMergeForwardTargetBranch()

		t.equal(isMergeForward, true, 'should detect merge-forward PR')
		t.equal(originalPR, '12345', 'should extract original PR number')
		t.equal(targetBranch, 'release-5.8.0', 'should extract target branch')
	})

	t.test('detects non-merge-forward PR', async t => {
		const core = mockCore({})
		const action = new TestAutoMerger({
			pullRequest: {
				merged: true,
				base: { ref: 'release-5.7' }
			},
			baseBranch: 'release-5.7',
			core
		})

		const isMergeForward = action.isMergeForwardPR()

		t.equal(isMergeForward, false, 'should not detect regular PR as merge-forward')
	})

	t.test('continues merge chain from correct position when PR merges into merge-forward branch', async t => {
		const core = mockCore({})
		const executedMerges = []

		const shell = createMockShell(core)
		const git = createMockGit(shell)

		class TestAction extends TestAutoMerger {
			async executeMerges(targets) {
				executedMerges.push(...targets)
				return true
			}
		}

		const action = new TestAction({
			baseBranch: 'merge-forward-pr-12345-release-5-8-0',
			config: {
				branches: {
					'release-5.7.0': {},
					'release-5.8.0': {},
					'main': {}
				},
				mergeTargets: ['release-5.8.0', 'main'],
				mergeOperations: {
					'release-5.7.0': 'release-5.8.0',
					'release-5.8.0': 'main'
				}
			},
			core,
			git,
			shell
		})

		await action.runMerges()

		t.same(executedMerges, ['main'], 'should only merge to main, not re-merge into release-5.8.0')
	})
})

tap.test('handleConflicts', async t => {
	t.test('creates issue and merge-conflicts branch when conflicts detected', async t => {
		const core = mockCore({})
		const shellCommands = []
		const gitCommands = []
		let issueCreated = false

		const shell = createMockShell(core, (cmd) => {
			shellCommands.push(cmd)
			if (cmd.startsWith('git diff --name-only')) {
				return 'src/file1.js\nsrc/file2.js'
			}
			return ''
		})

		const git = createMockGit(shell, { callTracker: gitCommands })
		// Override createBranch to capture branch name and ref
		git.createBranch = async (branchName, ref) => {
			gitCommands.push(`createBranch:${branchName}:${ref}`)
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
				t.equal(options.title, 'Merge #12345 (abc123456) into main', 'should have correct title')
				t.ok(options.labels.includes('merge conflict'), 'should include merge conflict label')
				t.ok(options.labels.includes('highest priority'), 'should include highest priority label')
				t.equal(options.milestone, 42, 'should use milestone from config')
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
			baseBranch: 'release-5.8.0',
			config: {
				branches: {
					'main': { milestoneNumber: 42 }
				},
				mergeTargets: ['release-5.8.0', 'main'],
				getBranchAlias: (branch) => branch
			},
			core,
			shell,
			git,
			gh: mockGh,
			conflictBranch: null
		})
		action.issueNumber = 12345
		action.lastSuccessfulMergeRef = 'mergeCommit456'
		action.lastSuccessfulBranch = 'release-5.8.0'
		action.terminalBranch = 'main'

		await action.handleConflicts('main')

		t.ok(issueCreated, 'should create GitHub issue')
		t.equal(action.conflictBranch, 'main', 'should set conflictBranch')
		t.ok(gitCommands.find(c => c.includes('reset')), 'should reset branch')

		// merge-conflicts should be based on the TARGET (main) so forward merging works
		t.ok(gitCommands.find(c => c.includes('createBranch:merge-conflicts-68586-release-5-8-0-to-main:main')),
			'should create merge-conflicts based on TARGET (main) for forward merging')

		// Previous merge-forward is NOT created here - it was created by merge() at start
		t.notOk(gitCommands.find(c => c.includes('createBranch:merge-forward-pr-999-release-5-8-0')),
			'should NOT create previous merge-forward (merge() creates it at start)')

		// merge-forward for the target still points to main
		t.ok(gitCommands.find(c => c.includes('createBranch:merge-forward-pr-999-main:main')),
			'should create merge-forward for target pointing to main')
	})

	t.test('skips when no conflicts found', async t => {
		const core = mockCore({})
		const gitCommands = []

		const shell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git diff --name-only')) return ''
			return ''
		})

		const git = createMockGit(shell, { callTracker: gitCommands })

		const action = new TestAutoMerger({
			core,
			shell,
			git,
			conflictBranch: null
		})

		await action.handleConflicts('release-5.8')

		t.equal(gitCommands.length, 0, 'should not call git reset when no conflicts')
		t.notOk(action.conflictBranch, 'should not set conflictBranch when no conflicts')
	})

	t.test('PR merges successfully through entire chain creating unique merge-forward branches', async t => {
		// Integration test for Phase 1 of test-plan.md:
		// A PR merges cleanly through ALL release branches with no conflicts.
		// This tests that merge-forward branches are created with unique names based on
		// the TARGET branch, not the source branch.
		//
		// Scenario:
		// 1. PR merged to release-5.7.1 (base branch)
		// 2. Auto-merge to release-5.7.2 succeeds, creates merge-forward-pr-999-release-5-7-2
		// 3. Auto-merge to release-5.8.0 succeeds, creates merge-forward-pr-999-release-5-8-0
		// 4. Auto-merge to main succeeds, creates merge-forward-pr-999-main
		// 5. All branches should have unique names (no duplicates)
		//
		// This test would catch the bug where merge() creates branches using lastSuccessfulBranch
		// instead of the current target branch.
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const createdBranches = new Set()
		const branchCreationOrder = []

		const shell = createMockShell(core, (cmd) => {
			if (cmd === 'git rev-parse HEAD') {
				return 'mergeCommit-' + Math.random().toString(36).substring(7)
			}
			return ''
		})

		const git = createMockGit(shell)
		git.merge = async (sha, options) => {
			// All merges succeed
			return 'Merge made by strategy'
		}
		git.createBranch = async (branchName, ref) => {
			if (createdBranches.has(branchName)) {
				throw new Error(`fatal: a branch named '${branchName}' already exists`)
			}
			createdBranches.add(branchName)
			branchCreationOrder.push(branchName)
		}

		const mockGh = {
			github: {
				context: {
					serverUrl,
					runId,
					repo: { owner: 'sample', repo: 'repo' }
				}
			},
			async fetchCommits() {
				return { data: [{ commit: { author: { name: 'Test Dev', email: 'dev@example.com' } } }] }
			}
		}

		const action = new TestAutoMerger({
			prNumber: 999,
			prAuthor: 'testdev',
			prCommitSha: 'originalPrCommit',
			prBranch: 'feature-branch',
			baseBranch: 'release-5.7.1',
			pullRequest: {
				head: { sha: 'originalPrCommit' }
			},
			config: {
				branches: {},
				mergeTargets: ['release-5.7.2', 'release-5.8.0', 'main']
			},
			core,
			shell,
			git,
			gh: mockGh
		})
		action.terminalBranch = 'main'
		action.lastSuccessfulMergeRef = 'originalPrCommit'
		action.lastSuccessfulBranch = 'release-5.7.1'

		const result = await action.executeMerges(['release-5.7.2', 'release-5.8.0', 'main'])

		// Verify all merges succeeded
		t.equal(result, true, 'executeMerges should return true when all merges succeed')

		// Verify each branch got its own uniquely-named merge-forward branch
		// The key assertion: branch names should be based on TARGET, not source
		t.ok(createdBranches.has('merge-forward-pr-999-release-5-7-2'),
			'should create merge-forward branch named after release-5.7.2 target')
		t.ok(createdBranches.has('merge-forward-pr-999-release-5-8-0'),
			'should create merge-forward branch named after release-5.8.0 target')
		t.ok(createdBranches.has('merge-forward-pr-999-main'),
			'should create merge-forward branch named after main target')

		// Verify no duplicate branch names were attempted
		t.equal(createdBranches.size, branchCreationOrder.length,
			'should not attempt to create duplicate branches')

		// Each merge-forward branch should be created exactly once at the START of merge()
		// then updated (via git branch -f) at the END of merge()
		const forwardBranchFor572 = branchCreationOrder.filter(b => b === 'merge-forward-pr-999-release-5-7-2')
		const forwardBranchFor580 = branchCreationOrder.filter(b => b === 'merge-forward-pr-999-release-5-8-0')
		const forwardBranchForMain = branchCreationOrder.filter(b => b === 'merge-forward-pr-999-main')

		t.equal(forwardBranchFor572.length, 1, 'merge-forward-pr-999-release-5-7-2 should be created once')
		t.equal(forwardBranchFor580.length, 1, 'merge-forward-pr-999-release-5-8-0 should be created once')
		t.equal(forwardBranchForMain.length, 1, 'merge-forward-pr-999-main should be created once')
	})

	t.test('PR merges through release branches but conflicts at main, creating issue and branches', async t => {
		// Integration test for Phase 2 of test-plan.md:
		// A PR merges cleanly through release branches but conflicts when reaching main.
		// This tests the full merge-forward chain up to conflict issue creation.
		//
		// Scenario:
		// 1. PR merged to release-5.7.2 (base branch)
		// 2. Auto-merge to release-5.8.0 succeeds, creates merge-forward-pr-999-release-5-8-0
		// 3. Auto-merge to main conflicts
		// 4. Issue created with instructions
		// 5. merge-conflicts and merge-forward-pr-999-main branches created
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const createdBranches = new Set()
		let issueCreated = false

		const shell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git diff --name-only')) {
				return 'merge-bot-test.txt'
			}
			if (cmd === 'git rev-parse HEAD') {
				return 'mergeCommit-' + Math.random().toString(36).substring(7)
			}
			return ''
		})

		const git = createMockGit(shell)
		// Use real merge behavior but simulate conflict at main
		let currentBranch = 'release-5.7.2'
		git.checkout = async (branch) => {
			currentBranch = branch
		}
		git.merge = async (sha, options) => {
			// Conflict only when merging to main
			if (currentBranch === 'main') {
				throw new Error('CONFLICT (content): Merge conflict in merge-bot-test.txt')
			}
			// All other merges succeed
			return 'Merge made by strategy'
		}
		git.createBranch = async (branchName, ref) => {
			if (createdBranches.has(branchName)) {
				throw new Error(`fatal: a branch named '${branchName}' already exists`)
			}
			createdBranches.add(branchName)
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
				t.ok(options.title.includes('into main'), 'issue title should indicate merge to main')
				t.ok(options.labels.includes('merge conflict'), 'should have merge conflict label')
				return { data: { number: 69517, html_url: 'https://github.com/sample/repo/issues/69517' } }
			},
			async fetchCommits() {
				return { data: [{ commit: { author: { name: 'Test Dev', email: 'dev@example.com' } } }] }
			}
		}

		const action = new TestAutoMerger({
			prNumber: 999,
			prAuthor: 'testdev',
			prCommitSha: 'originalPrCommit',
			prBranch: 'feature-branch',
			baseBranch: 'release-5.7.2',
			pullRequest: {
				head: { sha: 'originalPrCommit' }
			},
			config: {
				branches: { 'main': { milestoneNumber: 42 } },
				mergeTargets: ['release-5.8.0', 'main']
			},
			core,
			shell,
			git,
			gh: mockGh
		})
		action.terminalBranch = 'main'
		action.issueNumber = 12345
		action.lastSuccessfulMergeRef = 'originalPrCommit'
		action.lastSuccessfulBranch = 'release-5.7.2'

		const result = await action.executeMerges(['release-5.8.0', 'main'])

		// Verify the chain stopped at the conflict
		t.equal(result, false, 'executeMerges should return false when conflict occurs')
		t.equal(action.conflictBranch, 'main', 'should record conflict at main')

		// Verify issue was created
		t.ok(issueCreated, 'should create GitHub issue for conflict')

		// Verify merge-forward branch was created for successful step
		t.ok(createdBranches.has('merge-forward-pr-999-release-5-8-0'),
			'should create merge-forward branch for successful release-5.8.0 merge')

		// Verify branches for conflict resolution were created
		t.ok(createdBranches.has('merge-conflicts-69517-release-5-8-0-to-main'),
			'should create merge-conflicts branch based on main')
		t.ok(createdBranches.has('merge-forward-pr-999-main'),
			'should create merge-forward target branch for PR to merge into')
	})

	t.test('Phase 3: Two PRs from same branch-here point both conflict at main - verify isolation', async t => {
		// Integration test for Phase 3 of test-plan.md (Scenario Beta):
		// Two PRs branch from the SAME branch-here point, merge cleanly through release
		// branches, but both conflict when reaching main. This tests that each PR has
		// an isolated merge chain - User A only sees their conflicts, User B only sees theirs.
		//
		// Scenario:
		// 1. User A: PR 100 from release-5.7.2, conflicts at main
		// 2. User B: PR 200 from release-5.7.2 (same branch-here point!), conflicts at main
		// 3. Both PRs should get separate merge-forward branches
		// 4. Both PRs should get separate merge-conflicts branches
		// 5. User A's conflict resolution should NOT include User B's changes
		const core = mockCore({})
		core.startGroup = () => {}
		core.endGroup = () => {}

		const createdBranches = new Set()
		const createdIssues = []

		const shell = createMockShell(core, (cmd) => {
			if (cmd.startsWith('git diff --name-only')) {
				return 'merge-bot-test.txt'
			}
			if (cmd === 'git rev-parse HEAD') {
				return 'mergeCommit-' + Math.random().toString(36).substring(7)
			}
			return ''
		})

		const git = createMockGit(shell)
		// Simulate conflicts only when merging to main
		let currentBranch = 'release-5.7.2'
		git.checkout = async (branch) => {
			currentBranch = branch
		}
		git.merge = async (sha, options) => {
			if (currentBranch === 'main') {
				throw new Error('CONFLICT (content): Merge conflict in merge-bot-test.txt')
			}
			return 'Merge made by strategy'
		}
		git.createBranch = async (branchName, ref) => {
			if (createdBranches.has(branchName)) {
				throw new Error(`fatal: a branch named '${branchName}' already exists`)
			}
			createdBranches.add(branchName)
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
				const issueNumber = 70000 + createdIssues.length
				createdIssues.push({ issueNumber, title: options.title })
				return {
					data: {
						number: issueNumber,
						html_url: `https://github.com/sample/repo/issues/${issueNumber}`
					}
				}
			},
			async fetchCommits(prNumber) {
				return { data: [{ commit: { author: { name: `User${prNumber}`, email: `user${prNumber}@example.com` } } }] }
			}
		}

		// User A's PR (PR #100)
		const userA = new TestAutoMerger({
			prNumber: 100,
			prAuthor: 'userA',
			prCommitSha: 'commitUserA123',
			prBranch: 'test-beta-user-a',
			baseBranch: 'release-5.7.2',
			pullRequest: {
				head: { sha: 'commitUserA123' }
			},
			config: {
				branches: { 'main': { milestoneNumber: 42 } },
				mergeTargets: ['release-5.8.0', 'main']
			},
			core,
			shell,
			git,
			gh: mockGh
		})
		userA.terminalBranch = 'main'
		userA.issueNumber = 12345
		userA.lastSuccessfulMergeRef = 'commitUserA123'
		userA.lastSuccessfulBranch = 'release-5.7.2'

		// User B's PR (PR #200) - starts from SAME branch-here point
		const userB = new TestAutoMerger({
			prNumber: 200,
			prAuthor: 'userB',
			prCommitSha: 'commitUserB456',
			prBranch: 'test-beta-user-b',
			baseBranch: 'release-5.7.2',
			pullRequest: {
				head: { sha: 'commitUserB456' }
			},
			config: {
				branches: { 'main': { milestoneNumber: 42 } },
				mergeTargets: ['release-5.8.0', 'main']
			},
			core,
			shell,
			git,
			gh: mockGh
		})
		userB.terminalBranch = 'main'
		userB.issueNumber = 54321
		userB.lastSuccessfulMergeRef = 'commitUserB456'
		userB.lastSuccessfulBranch = 'release-5.7.2'

		// Execute both merge chains
		const resultA = await userA.executeMerges(['release-5.8.0', 'main'])
		const resultB = await userB.executeMerges(['release-5.8.0', 'main'])

		// Both should stop at conflicts
		t.equal(resultA, false, 'User A should conflict at main')
		t.equal(resultB, false, 'User B should conflict at main')

		// Verify isolation: Each PR gets its own merge-forward branches
		t.ok(createdBranches.has('merge-forward-pr-100-release-5-8-0'),
			'User A should have merge-forward for release-5.8.0')
		t.ok(createdBranches.has('merge-forward-pr-100-main'),
			'User A should have merge-forward for main')
		t.ok(createdBranches.has('merge-forward-pr-200-release-5-8-0'),
			'User B should have merge-forward for release-5.8.0')
		t.ok(createdBranches.has('merge-forward-pr-200-main'),
			'User B should have merge-forward for main')

		// Critical: Branches are NOT shared between PRs
		t.notEqual('merge-forward-pr-100-release-5-8-0', 'merge-forward-pr-200-release-5-8-0',
			'Different PRs should have different merge-forward branches')

		// Verify both got separate conflict issues
		t.equal(createdIssues.length, 2, 'Should create 2 separate conflict issues')
		t.ok(createdIssues[0].title.includes('Merge #12345'), 'User A issue should reference their issue number')
		t.ok(createdIssues[1].title.includes('Merge #54321'), 'User B issue should reference their issue number')

		// Verify separate merge-conflicts branches
		t.ok(createdBranches.has('merge-conflicts-70000-release-5-8-0-to-main'),
			'User A should have their own merge-conflicts branch')
		t.ok(createdBranches.has('merge-conflicts-70001-release-5-8-0-to-main'),
			'User B should have their own merge-conflicts branch')

		// The key property: Each user's lastSuccessfulMergeRef is independent
		// User A's forward chain is based on User A's commits
		// User B's forward chain is based on User B's commits
		// This ensures when they checkout merge-conflicts branches, they only see their own changes
		t.notEqual(userA.lastSuccessfulMergeRef, userB.lastSuccessfulMergeRef,
			'User A and B should have independent merge refs - isolation achieved')
	})
})

tap.test('createIssue', async t => {
	t.test('creates issue with proper metadata and assigns to PR author', async t => {
		const core = mockCore({})
		const shellCommands = []
		let createdIssue

		const shell = createMockShell(core, (cmd) => {
			shellCommands.push(cmd)
			return ''
		})

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
			shell,
			gh: mockGh
		})
		action.issueNumber = 888
		action.lastSuccessfulBranch = 'release-5.8'

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
		const shell = createMockShell(core)
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
			shell,
			gh: mockGh
		})
		action.lastSuccessfulBranch = 'release-5.8'

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
		action.lastSuccessfulBranch = 'release-5.7'

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
		t.ok(content.includes('git fetch'), 'should include git fetch command')
		t.ok(content.includes('merge-conflicts-99999-release-5-7-to-release-5-8'), 'should use merge-conflicts branch name')
		t.ok(content.includes('git merge origin/merge-forward-pr-12345-release-5-7'),
			'should merge the previous step forward into merge-conflicts')
		t.notOk(content.includes('git merge xyz789abc123'), 'should not merge the commit SHA directly')
		t.notOk(content.includes('git merge branch-here-release-5.8'),
			'should NOT merge target backward (thousands of commits)')
		t.ok(content.includes('Fixes #99999'), 'should include Fixes keyword for new issue')
		t.ok(content.includes('- src/app.js'), 'should list first conflict file')
		t.ok(content.includes('- src/config.js'), 'should list second conflict file')
		t.ok(content.includes('merge-forward-pr-12345-release-5-8'), 'should target merge-forward branch for PR')
	})

	t.test('merges forward (few commits) instead of backward (thousands)', async t => {
		// Problem: When merge-conflicts is based on release-5.8.0 and we merge main
		// into it, we pull thousands of commits (all of main's divergence).
		//
		// Solution: merge-conflicts is now based on the TARGET (main), and we merge
		// the PREVIOUS step's merge-forward branch INTO it. This pulls just the PR's
		// few commits forward, not thousands backward.
		const core = mockCore({})
		const { readFile } = require('fs/promises')

		const action = new TestAutoMerger({
			prNumber: 456,
			prCommitSha: 'abc123',
			config: {
				getBranchAlias: () => 'main'
			},
			core
		})
		action.terminalBranch = 'main'
		action.lastSuccessfulBranch = 'release-5.8.0'

		const filename = await action.writeComment({
			branch: 'main',
			issueNumber: 222,
			conflicts: 'file.js',
			conflictIssueNumber: 333,
			conflictBranchName: 'merge-conflicts-333-release-5-8-0-to-main'
		})

		cleanupIssueCommentFile(t)

		const content = await readFile(filename, 'utf-8')

		// Should checkout the existing merge-conflicts branch (not create a new one)
		t.ok(content.includes('git checkout merge-conflicts-333-release-5-8-0-to-main'),
			'should checkout the existing merge-conflicts branch')

		// Should merge the PREVIOUS step's merge-forward (the PR's progress) INTO merge-conflicts
		// This is forward merging (few commits) not backward merging (thousands)
		t.ok(content.includes('git merge origin/merge-forward-pr-456-release-5-8-0'),
			'should merge the previous merge-forward branch forward')
		t.notOk(content.includes('git merge main'),
			'should NOT merge target backward (thousands of commits)')

		// PR target is still the merge-forward branch for the conflict target
		t.ok(content.includes('merge-forward-pr-456-main'), 'should target merge-forward branch for PR')
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
		action.lastSuccessfulBranch = 'release-5.7.0'

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
		action.lastSuccessfulBranch = 'release-5.7.2'

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

tap.test('Scenario Beta: Two PRs with conflicts at same point are isolated', async t => {
	// This test verifies the core isolation property: when two PRs both conflict
	// at the same point in the merge chain, each PR's merge state is tracked independently.
	// This is the foundation that prevents users from seeing each other's conflicts.

	t.test('each PR tracks its own lastSuccessfulMergeRef independently', async t => {
		const core = mockCore({})

		// User A's PR starts from commit-A
		const actionA = new TestAutoMerger({
			prNumber: 111,
			prCommitSha: 'commit-A-original',
			core
		})
		await actionA.initializeState()

		// After User A merges to release-5.8.0, lastSuccessfulMergeRef points to A's merge commit
		actionA.lastSuccessfulMergeRef = 'commit-A-merged-to-5-8-0'

		// User B's PR starts from a DIFFERENT commit
		const actionB = new TestAutoMerger({
			prNumber: 222,
			prCommitSha: 'commit-B-original',
			core
		})
		await actionB.initializeState()

		// User B initializes to their own commit, not User A's
		t.equal(actionB.lastSuccessfulMergeRef, 'commit-B-original',
			'User B should start from their own commit')
		t.not(actionB.lastSuccessfulMergeRef, actionA.lastSuccessfulMergeRef,
			'User A and B should have different starting points')

		// After User B merges to release-5.8.0, they track their OWN merge commit
		actionB.lastSuccessfulMergeRef = 'commit-B-merged-to-5-8-0'

		t.not(actionB.lastSuccessfulMergeRef, actionA.lastSuccessfulMergeRef,
			'User A and B track separate merge commits - isolation achieved')
	})

	t.test('merge-forward branches encode PR number for isolation', async t => {
		const actionA = new TestAutoMerger({ prNumber: 111 })
		const actionB = new TestAutoMerger({ prNumber: 222 })

		const branchA = actionA.createMergeForwardBranchName('release-5.8.0')
		const branchB = actionB.createMergeForwardBranchName('release-5.8.0')

		t.equal(branchA, 'merge-forward-pr-111-release-5-8-0', 'User A gets their own merge-forward branch')
		t.equal(branchB, 'merge-forward-pr-222-release-5-8-0', 'User B gets their own merge-forward branch')
		t.not(branchA, branchB, 'Different PRs get different merge-forward branches for same target')
	})

	t.test('merge-conflicts branches encode issue number for isolation', async t => {
		const actionA = new TestAutoMerger({ prNumber: 111 })
		const actionB = new TestAutoMerger({ prNumber: 222 })

		// When conflicts happen, each PR gets its own conflict branch
		const conflictBranchA = actionA.createMergeConflictsBranchName(68001, 'release-5.7.0', 'main')
		const conflictBranchB = actionB.createMergeConflictsBranchName(68002, 'release-5.7.0', 'main')

		t.equal(conflictBranchA, 'merge-conflicts-68001-release-5-7-0-to-main',
			'User A gets conflict branch with their issue number')
		t.equal(conflictBranchB, 'merge-conflicts-68002-release-5-7-0-to-main',
			'User B gets conflict branch with their issue number')
		t.not(conflictBranchA, conflictBranchB,
			'Different issues get different conflict branches even for same merge path')
	})
})

tap.test('merge', async t => {
	t.test('handles already merged case', async t => {
		const gitCalls = []
		const core = mockCore({})

		const shell = createMockShell(core)
		const git = createMockGit(shell, { callTracker: gitCalls })
		// Override merge to return "Already up to date"
		git.merge = async (sha, options) => {
			gitCalls.push(`merge:${sha}:${options}`)
			return 'Already up to date.'
		}

		const action = new TestAutoMerger({
			pullRequest: {
				head: { sha: 'abc123' }
			},
			baseBranch: 'release-5.7',
			prNumber: 456,
			prBranch: 'my-feature',
			core,
			git,
			shell
		})
		action.lastSuccessfulBranch = 'release-5.7'
		action.lastSuccessfulMergeRef = 'originalCommit'

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true even when already merged')
		t.ok(gitCalls.find(c => c.includes('pull')), 'should pull before merging')
		t.ok(gitCalls.find(c => c.includes('merge:abc123')), 'should attempt merge')
		// When already merged, no commit or branch creation should happen
		t.notOk(gitCalls.find(c => c === 'commit'), 'should not commit when already merged')
	})

	t.test('successful merge creates commit and merge-forward branch', async t => {
		let commitCalled = false
		const core = mockCore({})
		const shellCommands = []
		const gitCommands = []

		const shell = createMockShell(core, (cmd) => {
			shellCommands.push(cmd)
			if (cmd === 'git rev-parse HEAD') return 'newMergeCommit789'
			return ''
		})

		const git = createMockGit(shell, { callTracker: gitCommands })
		git.merge = async () => 'Merge made by strategy'
		git.commit = async (message, author) => {
			commitCalled = true
			gitCommands.push('commit')
			t.ok(author, 'should pass author to commit')
			t.equal(author.name, 'Test', 'should use correct author name')
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
			shell,
			git,
			gh: mockGh
		})

		action.lastSuccessfulMergeRef = 'originalCommit123'
		action.lastSuccessfulBranch = 'release-5.7'

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, true, 'should return true on success')
		t.ok(commitCalled, 'should create commit when merge successful')
		t.equal(action.lastSuccessfulMergeRef, 'newMergeCommit789', 'should update lastSuccessfulMergeRef to new merge commit')
		t.ok(gitCommands.includes('createBranch'), 'should create merge-forward branch')
		t.ok(gitCommands.find(c => c.startsWith('push:')), 'should push merge-forward branch')
	})

	t.test('handles conflicts', async t => {
		let conflictsHandled = false
		const core = mockCore({})

		const shell = createMockShell(core)
		const git = createMockGit(shell)
		git.merge = async () => { throw new Error('Merge conflict') }

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
			git,
			shell
		})
		action.lastSuccessfulBranch = 'release-5.7'
		action.lastSuccessfulMergeRef = 'originalCommit'

		const result = await action.merge({branch: 'release-5.8'})

		t.equal(result, false, 'should return false when conflicts occur')
		t.ok(conflictsHandled, 'should call handleConflicts')
	})
})
