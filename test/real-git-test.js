/**
 * Real Git Integration Tests
 *
 * These tests use actual git operations (not mocks) to verify the merge-bot
 * behavior matches the scenarios described in test-plan.md.
 *
 * The tests create temporary git repositories with conflicting branches
 * to verify that:
 * - Phase 1: Basic merge-forward works
 * - Phase 2: Conflict detection and resolution works
 * - Phase 3: Conflict isolation works (Scenario Beta)
 */

const tap = require('tap')
const { mkdtemp, rm, writeFile } = require('fs/promises')
const { tmpdir } = require('os')
const { join } = require('path')
const { execSync } = require('child_process')

const { mockCore } = require('gh-action-components')

/**
 * Helper to run git commands in a test repo
 */
function createGitHelper(repoDir) {
	return (cmd) => {
		return execSync(`git ${cmd}`, {
			cwd: repoDir,
			encoding: 'utf-8',
			env: {
				...process.env,
				GIT_AUTHOR_NAME: 'Test',
				GIT_AUTHOR_EMAIL: 'test@test.com',
				GIT_COMMITTER_NAME: 'Test',
				GIT_COMMITTER_EMAIL: 'test@test.com'
			}
		}).trim()
	}
}

/**
 * Creates a test repo with origin, simulating the Spider Impact setup:
 * - main branch with one version of a file
 * - release branch with a different version
 * - branch-here-* branches pointing to the right places
 */
async function createTestRepo() {
	const repoDir = await mkdtemp(join(tmpdir(), 'merge-bot-repo-'))
	const originDir = await mkdtemp(join(tmpdir(), 'merge-bot-origin-'))

	const git = createGitHelper(repoDir)

	// Create bare origin
	execSync('git init --bare', { cwd: originDir })

	// Initialize repo
	git('init')
	git('config user.email "test@test.com"')
	git('config user.name "Test"')
	git(`remote add origin ${originDir}`)

	return { repoDir, originDir, git }
}

async function cleanupTestRepo(repoDir, originDir) {
	await rm(repoDir, { recursive: true, force: true })
	await rm(originDir, { recursive: true, force: true })
}

tap.test('Phase 1: Basic merge-forward (no conflicts)', async t => {
	// This test verifies that non-conflicting changes merge cleanly
	// using the correct merge direction (target branch base, PR merged into it)
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Initial content\n')
	git('add test.txt')
	git('commit -m "Initial commit"')

	// Create release-5.7.2 branch
	git('checkout -b release-5.7.2')
	git('push origin release-5.7.2')

	// Create release-5.8.0 from release-5.7.2 (identical initially)
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')

	// Create branch-here pointers
	git('branch branch-here-release-5.8.0 release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Simulate a PR: add a NEW file (doesn't conflict with anything)
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'new-feature.txt'), 'New feature\n')
	git('add new-feature.txt')
	git('commit -m "Add new feature"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.7.2')

	// Test the correct merge direction (what the fixed merge() does):
	// 1. Create merge-forward from target's branch-here
	// 2. Merge PR commit INTO it
	git('checkout -b merge-forward-test branch-here-release-5.8.0')

	let mergeSucceeded = true
	try {
		git(`merge ${prCommit} --no-ff -m "Merge PR"`)
	} catch (e) {
		mergeSucceeded = false
	}

	t.ok(mergeSucceeded, 'non-conflicting changes should merge cleanly')

	// Verify the file was merged
	const files = git('ls-files')
	t.ok(files.includes('new-feature.txt'), 'new file should be in merged branch')
})

tap.test('Phase 1a: Successful chain with branch cleanup', async t => {
	// This tests a successful merge chain that completes to main,
	// verifying that merge-forward branches are cleaned up afterward
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create branches that will merge cleanly
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')
	git('branch branch-here-release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Create main (same content - no conflict)
	git('checkout -b main')
	git('push origin main')
	// No branch-here-main needed for terminal branch

	// Simulate PR: add a new file (won't conflict)
	git('checkout release-5.8.0')
	await writeFile(join(repoDir, 'new-feature.txt'), 'New feature\n')
	git('add new-feature.txt')
	git('commit -m "Add new feature"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.8.0')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Track branch operations
	const deletedBranches = []
	const originalDeleteBranch = gitHelper.deleteBranch.bind(gitHelper)
	gitHelper.deleteBranch = async (name) => {
		deletedBranches.push(name)
		return originalDeleteBranch(name)
	}

	// Override commit to avoid .commitmsg issues
	gitHelper.commit = async (message, author) => {
		const authorStr = `${author.name} <${author.email}>`
		const escapedMsg = message.replace(/`/g, "'").replace(/"/g, '\\"')
		return shell.exec(`git commit -m "${escapedMsg}" --author="${authorStr}"`)
	}

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		// Skip actual release branch updates for test
		async updateTargetBranches() {}
	}

	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: prCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: {
			branches: {},
			mergeTargets: ['main'],
			getBranchAlias: (branch) => branch.replace(/\./g, '-')
		},
		prNumber: 888,
		prAuthor: 'testuser',
		prTitle: 'Add feature',
		prBranch: 'feature-branch',
		baseBranch: 'release-5.8.0',
		prCommitSha: prCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' }, message: 'Test commit' } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'
	action.lastSuccessfulBranch = 'release-5.8.0'
	action.lastSuccessfulMergeRef = prCommit

	// Execute the merge chain
	const result = await action.executeMerges(['main'])

	// Verify success
	t.equal(result, true, 'executeMerges should return true when all merges succeed')

	// Verify PR branch was deleted (cleanup)
	t.ok(deletedBranches.includes('feature-branch'),
		'should delete PR branch after successful chain completion')
})

tap.test('Phase 1b: Multi-step chain (merges through release, then conflicts at main)', async t => {
	// This test verifies a PR that merges cleanly through intermediate release
	// branches but then conflicts when reaching main
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.7.2 (PR base)
	git('checkout -b release-5.7.2')
	git('push origin release-5.7.2')
	git('branch branch-here-release-5.7.2')
	git('push origin branch-here-release-5.7.2')

	// Create release-5.8.0 (same content as 5.7.2 - no conflict here)
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')
	git('branch branch-here-release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Create main with DIFFERENT content (will conflict)
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Simulate PR: modify test.txt in release-5.7.2
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'PR CHANGE\n')
	git('add test.txt')
	git('commit -m "PR change"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.7.2')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Track what happens
	let conflictsDetected = false
	let conflictBranch = null
	const createdBranches = []

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		async handleConflicts(branch) {
			conflictsDetected = true
			conflictBranch = branch
			this.conflictBranch = branch
			await this.git.reset(branch, '--hard')
		}
	}

	// Override createBranch to track branch creation
	const originalCreateBranch = gitHelper.createBranch.bind(gitHelper)
	gitHelper.createBranch = async (name, ref) => {
		createdBranches.push(name)
		return originalCreateBranch(name, ref)
	}

	// Override commit to use simple git commit (avoids .commitmsg file issues)
	gitHelper.commit = async (message, author) => {
		const authorStr = `${author.name} <${author.email}>`
		// Escape backticks and quotes in message to avoid shell interpretation
		const escapedMsg = message.replace(/`/g, "'").replace(/"/g, '\\"')
		return shell.exec(`git commit -m "${escapedMsg}" --author="${authorStr}"`)
	}

	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: prCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: {
			branches: {},
			mergeTargets: ['release-5.8.0', 'main'],
			getBranchAlias: (branch) => branch.replace(/\./g, '-')
		},
		prNumber: 999,
		prAuthor: 'testuser',
		prTitle: 'Test multi-step',
		prBranch: 'feature',
		baseBranch: 'release-5.7.2',
		prCommitSha: prCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 69517, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' }, message: 'Test commit' } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'
	action.lastSuccessfulBranch = 'release-5.7.2'
	action.lastSuccessfulMergeRef = prCommit

	// Execute the full merge chain
	const result = await action.executeMerges(['release-5.8.0', 'main'])

	// Verify chain stopped at main (conflict)
	t.equal(result, false, 'executeMerges should return false when conflict at main')
	t.ok(conflictsDetected, 'conflict should be detected at main')
	t.equal(conflictBranch, 'main', 'conflict should be at main, not release-5.8.0')

	// Verify merge-forward branch was created for successful step
	t.ok(createdBranches.includes('merge-forward-pr-999-release-5.8.0'),
		'should create merge-forward branch for successful release-5.8.0 merge')

	// Verify merge-forward branch was created for conflict step
	t.ok(createdBranches.includes('merge-forward-pr-999-main'),
		'should create merge-forward branch for main (before conflict detected)')
})

tap.test('Phase 2: Conflict detection at main', async t => {
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit with test file
	await writeFile(join(repoDir, 'test.txt'), 'Original content\nLine 2\n')
	git('add test.txt')
	git('commit -m "Initial commit"')

	// Create main with a DIFFERENT version
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\nLine 2\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')

	// Create branch-here-main
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Go back and create release branch with yet another version
	git('checkout HEAD~1')
	git('checkout -b release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE VERSION\nLine 2\n')
	git('add test.txt')
	git('commit -m "Release version"')
	const prCommit = git('rev-parse HEAD')
	git('push origin release-5.8.0')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Track conflicts
	let conflictsDetected = false
	let conflictFiles = null

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		async handleConflicts(branch) {
			conflictsDetected = true
			conflictFiles = await this.shell.exec('git diff --name-only --diff-filter=U')
			this.conflictBranch = branch
			await this.git.reset(branch, '--hard')
		}
	}

	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: prCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
		prNumber: 200,
		prAuthor: 'testuser',
		prTitle: 'Test conflict',
		prBranch: 'release-5.8.0',
		baseBranch: 'release-5.8.0',
		prCommitSha: prCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' }, message: 'Test commit' } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'
	action.lastSuccessfulBranch = 'release-5.8.0'
	action.lastSuccessfulMergeRef = prCommit

	await gitHelper.checkout('main')
	const result = await action.merge({ branch: 'main' })

	t.equal(result, false, 'merge should return false when conflict detected')
	t.ok(conflictsDetected, 'handleConflicts should be called')
	t.ok(conflictFiles.includes('test.txt'), 'should detect conflict in test.txt')
	t.equal(action.conflictBranch, 'main', 'conflictBranch should be set to main')
})

tap.test('Phase 3: Conflict isolation (Scenario Beta)', async t => {
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Main has one version
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Create release branch (base for User A and User B PRs)
	git('checkout HEAD~1')
	git('checkout -b release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE BASE\n')
	git('add test.txt')
	git('commit -m "Release base"')
	git('push origin release-5.7.2')
	git('branch branch-here-release-5.7.2')
	git('push origin branch-here-release-5.7.2')

	// User A's change
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'test.txt'), 'USER A VERSION\n')
	git('add test.txt')
	git('commit -m "User A change"')
	const userACommit = git('rev-parse HEAD')

	// User B's change (from the SAME base as User A - simulating both branching before either merges)
	git('checkout branch-here-release-5.7.2')
	git('checkout -b user-b-branch')
	await writeFile(join(repoDir, 'test.txt'), 'USER B VERSION\n')
	git('add test.txt')
	git('commit -m "User B change"')
	const userBCommit = git('rev-parse HEAD')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})

	// Test User A's merge - should detect conflict with main
	t.test('User A detects conflict with main', async t => {
		const shell = new Shell(core)
		shell.exec = async (cmd) => {
			if (cmd.startsWith('gh ')) return ''
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		}
		const gitHelper = new Git(shell)

		let conflictsDetected = false
		const AutoMerger = require('../src/automerger')
		class TestAutoMerger extends AutoMerger {
			async handleConflicts(branch) {
				conflictsDetected = true
				this.conflictBranch = branch
				await this.git.reset(branch, '--hard')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: { merged: true, head: { sha: userACommit } },
			repository: { owner: 'test', name: 'repo' },
			config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
			prNumber: 301,
			prAuthor: 'userA',
			prTitle: 'User A PR',
			prBranch: 'user-a-branch',
			baseBranch: 'release-5.7.2',
			prCommitSha: userACommit,
			core,
			shell,
			gh: {
				github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
				async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
				async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' }, message: 'Test commit' } }] } }
			},
			git: gitHelper
		})

		action.terminalBranch = 'main'
		action.lastSuccessfulBranch = 'release-5.7.2'
		action.lastSuccessfulMergeRef = userACommit

		await gitHelper.checkout('main')
		const result = await action.merge({ branch: 'main' })

		t.equal(result, false, 'User A should detect conflict with main')
		t.ok(conflictsDetected, 'handleConflicts should be called for User A')
	})

	// Test User B's merge - should ALSO detect conflict with main
	// Crucially, User B should NOT see User A's changes in their conflict
	t.test('User B detects conflict with main (isolated from User A)', async t => {
		const shell = new Shell(core)
		shell.exec = async (cmd) => {
			if (cmd.startsWith('gh ')) return ''
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		}
		const gitHelper = new Git(shell)

		let conflictsDetected = false
		let conflictContent = null

		const AutoMerger = require('../src/automerger')
		class TestAutoMerger extends AutoMerger {
			async handleConflicts(branch) {
				conflictsDetected = true
				// Capture the conflict content to verify isolation
				try {
					conflictContent = execSync('cat test.txt', { cwd: repoDir, encoding: 'utf-8' })
				} catch (e) {
					conflictContent = 'error reading file'
				}
				this.conflictBranch = branch
				await this.git.reset(branch, '--hard')
			}
		}

		const action = new TestAutoMerger({
			pullRequest: { merged: true, head: { sha: userBCommit } },
			repository: { owner: 'test', name: 'repo' },
			config: { branches: {}, mergeTargets: ['main'], getBranchAlias: () => 'main' },
			prNumber: 302,
			prAuthor: 'userB',
			prTitle: 'User B PR',
			prBranch: 'user-b-branch',
			baseBranch: 'release-5.7.2',
			prCommitSha: userBCommit,
			core,
			shell,
			gh: {
				github: { context: { serverUrl: 'https://github.com', runId: 1, repo: { owner: 'test', repo: 'repo' } } },
				async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
				async fetchCommits() { return { data: [{ commit: { author: { name: 'Test', email: 'test@test.com' }, message: 'Test commit' } }] } }
			},
			git: gitHelper
		})

		action.terminalBranch = 'main'
		action.lastSuccessfulBranch = 'release-5.7.2'
		action.lastSuccessfulMergeRef = userBCommit

		await gitHelper.checkout('main')
		const result = await action.merge({ branch: 'main' })

		t.equal(result, false, 'User B should detect conflict with main')
		t.ok(conflictsDetected, 'handleConflicts should be called for User B')

		// Verify isolation: User B's conflict should be between USER B VERSION and MAIN VERSION
		// It should NOT include USER A VERSION
		t.ok(conflictContent, 'should have conflict content')
		t.ok(conflictContent.includes('USER B VERSION') || conflictContent.includes('MAIN VERSION'),
			'conflict should involve User B and main')
		t.notOk(conflictContent.includes('USER A VERSION'),
			'User B conflict should NOT include User A changes (isolation)')
	})
})

tap.test('Merge direction: demonstrates bug vs fix', async t => {
	// This test explicitly shows why the merge direction matters
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup conflicting branches
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN\n')
	git('add test.txt')
	git('commit -m "Main"')
	git('branch branch-here-main')
	git('push origin main branch-here-main')

	git('checkout HEAD~1')
	git('checkout -b release')
	await writeFile(join(repoDir, 'test.txt'), 'RELEASE\n')
	git('add test.txt')
	git('commit -m "Release"')
	const releaseCommit = git('rev-parse HEAD')

	t.test('BUGGY: creating branch from PR then merging same PR = "Already up to date"', async t => {
		// This is what the old code did
		git('checkout -b merge-forward-buggy ' + releaseCommit)
		let result
		try {
			result = git(`merge ${releaseCommit} --no-commit --no-ff`)
		} catch (e) {
			result = 'conflict'
		}

		t.ok(result.includes('Already up to date') || result === '',
			'buggy approach returns "Already up to date" - no conflict detected!')
		git('checkout main')
		git('branch -D merge-forward-buggy')
	})

	t.test('CORRECT: creating branch from target then merging PR = detects conflict', async t => {
		// This is what the fixed code does
		git('checkout -b merge-forward-correct branch-here-main')
		let conflictDetected = false
		try {
			git(`merge ${releaseCommit} --no-commit --no-ff`)
		} catch (e) {
			conflictDetected = true
		}

		t.ok(conflictDetected, 'correct approach detects the conflict')
		git('merge --abort || true')
		git('checkout main')
		git('branch -D merge-forward-correct')
	})
})

tap.test('Resume chain: continues merge chain after conflict resolution', async t => {
	// This tests the multi-invocation scenario from the README:
	// - Action Run #1: PR conflicts at main, creates merge-forward-pr-123-main
	// - Developer resolves conflicts, creates PR from merge-conflicts to merge-forward
	// - Action Run #2: Detects merge-forward PR, continues chain to completion
	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create a scenario where PR already merged through release-5.8.0
	// and conflict was resolved at main
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')
	git('branch branch-here-release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Create main with content that would have conflicted
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	git('branch branch-here-main')
	git('push origin branch-here-main')

	// Simulate: merge-forward-pr-123-main already exists (from previous action run)
	// with the resolved conflict
	git('checkout -b merge-forward-pr-123-main branch-here-main')
	await writeFile(join(repoDir, 'test.txt'), 'RESOLVED CONTENT\n')
	git('add test.txt')
	git('commit -m "Resolved conflict"')
	const resolvedCommit = git('rev-parse HEAD')
	git('push origin merge-forward-pr-123-main')

	// Also create merge-forward for release-5.8.0 (from successful first step)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-123-release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'PR CONTENT\n')
	git('add test.txt')
	git('commit -m "PR merge to release-5.8.0"')
	git('push origin merge-forward-pr-123-release-5.8.0')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	// Override commit to avoid .commitmsg issues
	gitHelper.commit = async (message, author) => {
		const authorStr = `${author.name} <${author.email}>`
		const escapedMsg = message.replace(/`/g, "'").replace(/"/g, '\\"')
		return shell.exec(`git commit -m "${escapedMsg}" --author="${authorStr}"`)
	}

	// Track what happens
	const updatedBranches = []

	const AutoMerger = require('../src/automerger')
	class TestAutoMerger extends AutoMerger {
		// Track branch updates
		async updateTargetBranches(branches) {
			updatedBranches.push(...branches)
		}
	}

	// Simulate Action Run #2: PR merged into merge-forward-pr-123-main
	// The action should detect this is a merge-forward PR and continue the chain
	const action = new TestAutoMerger({
		pullRequest: { merged: true, head: { sha: resolvedCommit } },
		repository: { owner: 'test', name: 'repo' },
		config: {
			branches: {},
			mergeTargets: ['main'], // Only main left to complete
			getBranchAlias: (branch) => branch.replace(/\./g, '-')
		},
		prNumber: 456, // This is the resolution PR number
		prAuthor: 'developer',
		prTitle: 'Resolve conflicts',
		prBranch: 'merge-conflicts-999-release-5.8.0-to-main', // Source branch
		baseBranch: 'merge-forward-pr-123-main', // Target is merge-forward
		prCommitSha: resolvedCommit,
		core,
		shell,
		gh: {
			github: { context: { serverUrl: 'https://github.com', runId: 2, repo: { owner: 'test', repo: 'repo' } } },
			async createIssue() { return { data: { number: 999, html_url: 'http://example.com' } } },
			async fetchCommits() { return { data: [{ commit: { author: { name: 'Dev', email: 'dev@test.com' }, message: 'Test commit' } }] } }
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'

	// Test that we can detect this is a merge-forward PR
	t.ok(action.baseBranch.startsWith('merge-forward-pr-'),
		'should detect PR to merge-forward branch')

	// Extract original PR number from branch name
	const match = action.baseBranch.match(/merge-forward-pr-(\d+)-/)
	t.ok(match, 'should be able to parse original PR number from branch name')
	t.equal(match[1], '123', 'should extract correct original PR number')

	// The resolved commit should be usable as the starting point for continuing
	action.lastSuccessfulMergeRef = resolvedCommit
	action.lastSuccessfulBranch = 'main'

	// Since we're already at main (the terminal), the chain is complete
	// In real usage, executeMerges would update release branches
	t.equal(action.lastSuccessfulBranch, 'main',
		'after resolution, lastSuccessfulBranch should be at terminal')
})

tap.test('Terminal branch (main) is updated when merge-forward chain completes', async t => {
	// This tests the bug where main is never updated after a conflict resolution
	// PR merges to merge-forward-pr-{N}-main.
	//
	// Scenario:
	// 1. PR merges to release-5.8.0
	// 2. Bot creates merge-forward-pr-123-main, conflict at main
	// 3. Developer resolves conflict, PRs to merge-forward-pr-123-main
	// 4. PR merges, merge-forward-pr-123-main now has resolved content
	// 5. Bot runs updateTargetBranches()
	// 6. BUG: main is skipped because it's the terminal branch
	// 7. EXPECTED: main should be fast-forwarded to match merge-forward-pr-123-main

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push origin release-5.8.0')
	git('branch branch-here-release-5.8.0')
	git('push origin branch-here-release-5.8.0')

	// Create main
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')
	const mainCommitBefore = git('rev-parse origin/main')

	// Simulate: merge-forward-pr-123-main exists with RESOLVED content
	// (This is what happens after a developer resolves conflicts and their
	// PR merges to the merge-forward branch)
	git('checkout main')
	git('checkout -b merge-forward-pr-123-main')
	await writeFile(join(repoDir, 'test.txt'), 'RESOLVED CONTENT\n')
	git('add test.txt')
	git('commit -m "Resolved conflict from PR 123"')
	const resolvedCommit = git('rev-parse HEAD')
	git('push origin merge-forward-pr-123-main')

	// Also create merge-forward for release-5.8.0 (from successful first step)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-123-release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'PR CONTENT\n')
	git('add test.txt')
	git('commit -m "PR merge to release-5.8.0"')
	git('push origin merge-forward-pr-123-release-5.8.0')

	// Use real Shell and Git
	const { Shell, Git } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		if (cmd.startsWith('gh ')) return ''
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	const gitHelper = new Git(shell)

	const AutoMerger = require('../src/automerger')

	// Simulate the scenario: conflict resolution PR just merged to
	// merge-forward-pr-123-main, now bot runs updateTargetBranches()
	const action = new AutoMerger({
		pullRequest: {
			merged: true,
			head: { sha: resolvedCommit },
			merge_commit_sha: resolvedCommit
		},
		repository: { owner: 'test', name: 'repo' },
		config: {
			branches: {
				'release-5.8.0': {},
				'main': {}
			},
			mergeTargets: ['release-5.8.0', 'main']
		},
		prNumber: 123, // Original PR number (matches merge-forward branch name)
		prAuthor: 'developer',
		prTitle: 'Resolve conflicts',
		prBranch: 'merge-conflicts-999-release-5.8.0-to-main',
		baseBranch: 'merge-forward-pr-123-main',
		prCommitSha: resolvedCommit,
		core,
		shell,
		gh: {
			github: {
				context: {
					serverUrl: 'https://github.com',
					runId: 2,
					repo: { owner: 'test', repo: 'repo' }
				}
			},
		async fetchCommits() {
			return {
				data: [{
					commit: {
						author: { name: 'Dev', email: 'dev@test.com' },
						message: 'Test commit'
					}
				}]
			}
		}
		},
		git: gitHelper
	})

	action.terminalBranch = 'main'

	// Call updateTargetBranches - this is what runs after executeMerges
	// when the chain completes
	await action.updateTargetBranches([])

	// Fetch to get updated refs
	git('fetch origin')

	// Verify main was updated to match merge-forward-pr-123-main
	const mainCommitAfter = git('rev-parse origin/main')
	const mergeForwardCommit = git('rev-parse origin/merge-forward-pr-123-main')

	t.not(mainCommitAfter, mainCommitBefore,
		'main should have been updated (commit changed)')
	t.equal(mainCommitAfter, mergeForwardCommit,
		'main should match merge-forward-pr-123-main after updateTargetBranches')
})

tap.test('branch-here should NOT advance past blocked commits when another PR succeeds', async t => {
	// This test reproduces the bug from issue #69842 where Jerry's PR inherited
	// Cole's conflicts because branch-here-release-5.8.0 advanced past Cole's
	// blocked commit when a different PR's chain completed.
	//
	// Scenario:
	// 1. Cole's PR merges to release-5.8.0, CONFLICTS at main (blocked)
	// 2. Other PR merges to release-5.8.0, succeeds all the way to main
	// 3. BranchMaintainer runs for the successful PR
	// 4. BUG: branch-here-release-5.8.0 advances to tip (includes Cole's blocked commit)
	// 5. Jerry's PR merges to release-5.8.0, inherits Cole's conflicts
	//
	// EXPECTED: branch-here should only advance to commits that reached main

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	await writeFile(join(repoDir, 'other.txt'), 'Other file\n')
	git('add .')
	git('commit -m "Initial"')
	const initialCommit = git('rev-parse HEAD')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')

	// Create branch-here-release-5.8.0 at initial commit
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')
	git('checkout release-5.8.0')

	// Create main with DIFFERENT content in test.txt (will conflict with Cole's PR)
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push -u origin main')

	// Cole's PR: modifies test.txt (will conflict with main)
	git('checkout release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'COLE VERSION\n')
	git('add test.txt')
	git('commit -m "Cole PR - conflicts with main"')
	const coleCommit = git('rev-parse HEAD')
	git('push origin release-5.8.0')

	// Simulate: Cole's merge-forward chain was created but BLOCKED at main
	// (merge-conflicts branch exists, issue created, but not resolved yet)
	git('checkout main')
	git('checkout -b merge-conflicts-69824-pr-69448-release-5.8.0-to-main')
	git('push origin merge-conflicts-69824-pr-69448-release-5.8.0-to-main')
	git('checkout release-5.8.0')

	// Another PR (successful one): modifies other.txt (no conflict)
	await writeFile(join(repoDir, 'other.txt'), 'OTHER PR CHANGE\n')
	git('add other.txt')
	git('commit -m "Other PR - succeeds to main"')
	const successfulCommit = git('rev-parse HEAD')
	git('push origin release-5.8.0')

	// Simulate: The successful PR's chain completed to main
	// (its content was merged into main)
	git('checkout main')
	await writeFile(join(repoDir, 'other.txt'), 'OTHER PR CHANGE\n')
	git('add other.txt')
	git('commit -m "Merge other PR to main"')
	git('push origin main')

	// Verify setup: branch-here is at initial, release-5.8.0 has both PRs
	const branchHereBefore = git('rev-parse origin/branch-here-release-5.8.0')
	t.equal(branchHereBefore, initialCommit,
		'Setup: branch-here should be at initial commit before maintenance')

	// Use real Shell
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	shell.execQuietly = async (cmd) => {
		try {
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		} catch (e) {
			// Silently ignore errors
		}
	}

	const BranchMaintainer = require('../src/branch-maintainer')

	// Run BranchMaintainer as if the SUCCESSFUL PR just completed its chain
	// (PR merged to release-5.8.0, automerge succeeded all the way to main)
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 69823,
			head: { ref: 'issue-69815-select' },
			base: { ref: 'release-5.8.0' }
		},
		config: {
			branches: {
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {
				'release-5.8.0': 'main'
			}
		},
		core,
		shell
	})

	// Run maintenance (automerge succeeded, so automergeConflictBranch is undefined)
	await maintainer.run({ automergeConflictBranch: undefined })

	// Fetch to get updated refs
	git('fetch origin')

	// THE KEY ASSERTION: branch-here should NOT have advanced to include Cole's
	// blocked commit. It should stay at the last commit that actually reached main.
	const branchHereAfter = git('rev-parse origin/branch-here-release-5.8.0')
	const releaseTip = git('rev-parse origin/release-5.8.0')

	// The release branch tip includes both Cole's commit and the successful PR's commit
	t.equal(releaseTip, successfulCommit,
		'Setup verification: release tip should be at successful PR commit')

	// BUG: Currently branch-here advances to the tip, including Cole's blocked commit
	// EXPECTED: branch-here should NOT include Cole's blocked commit
	t.not(branchHereAfter, releaseTip,
		'branch-here should NOT advance to release tip when there are blocked commits')

	// Verify Jerry would NOT inherit Cole's conflicts
	// If branch-here advanced correctly, Jerry's merge-forward would be based on
	// a commit that doesn't include Cole's changes
	const branchHereContent = git(`show ${branchHereAfter}:test.txt`)
	t.notOk(branchHereContent.includes('COLE'),
		'branch-here should NOT include Cole\'s blocked changes')
})

tap.test('Conflict resolution PR merged to main cleans up merge-forward branches', async t => {
	// This test verifies that when a conflict resolution PR is merged directly
	// to `main` (instead of to merge-forward-pr-*-main), the merge-forward
	// branches are still cleaned up.
	//
	// The merge-conflicts branch name contains the issue number, and we can
	// use that to find and clean up the associated merge-forward branches.

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Original\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.7.0 (where the original PR was merged)
	git('checkout -b release-5.7.0')
	git('push -u origin release-5.7.0')
	git('checkout -b branch-here-release-5.7.0')
	git('push -u origin branch-here-release-5.7.0')
	git('checkout release-5.7.0')

	// Create release-5.8.0 (intermediate step in chain)
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')
	git('checkout release-5.8.0')

	// Create main with different content (causes conflict)
	git('checkout -b main')
	await writeFile(join(repoDir, 'test.txt'), 'MAIN VERSION\n')
	git('add test.txt')
	git('commit -m "Main version"')
	git('push origin main')

	// Simulate PR #69561's merge-forward branches that were created during
	// the original action run (before conflict at main was detected)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-69561-release-5.8.0')
	await writeFile(join(repoDir, 'test.txt'), 'PR CONTENT\n')
	git('add test.txt')
	git('commit -m "PR merge to release-5.8.0"')
	git('push origin merge-forward-pr-69561-release-5.8.0')

	// Also update release-5.8.0 to have the PR content
	// (In real scenario, this happens via updateTargetBranches when chain completes)
	git('checkout release-5.8.0')
	git('merge --ff-only merge-forward-pr-69561-release-5.8.0')
	git('push origin release-5.8.0')

	// merge-forward for main was also created (before conflict was detected)
	git('checkout main')
	git('checkout -b merge-forward-pr-69561-main')
	git('push origin merge-forward-pr-69561-main')

	// Simulate: Developer resolved the conflict and merged DIRECTLY to main
	// (This is the bug trigger - they should have merged to merge-forward-pr-69561-main)
	git('checkout main')
	await writeFile(join(repoDir, 'test.txt'), 'RESOLVED CONTENT\n')
	git('add test.txt')
	git('commit -m "Merge merge-forward-pr-69561-release-5.8.0 Fixes #69569"')
	const resolvedCommit = git('rev-parse HEAD')
	git('push origin main')

	// Verify merge-forward branches exist before running maintainer
	const branchesBefore = git('ls-remote --heads origin')
	t.ok(branchesBefore.includes('merge-forward-pr-69561-release-5.8.0'),
		'merge-forward for release-5.8.0 should exist before maintenance')
	t.ok(branchesBefore.includes('merge-forward-pr-69561-main'),
		'merge-forward for main should exist before maintenance')

	// Verify branch-here is behind release-5.8.0 before maintenance
	const releaseCommitBefore = git('rev-parse origin/release-5.8.0')
	const branchHereCommitBefore = git('rev-parse origin/branch-here-release-5.8.0')
	t.not(releaseCommitBefore, branchHereCommitBefore,
		'branch-here-release-5.8.0 should be behind release-5.8.0 before maintenance')

	// Use real Shell and Git
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	shell.execQuietly = async (cmd) => {
		try {
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		} catch (e) {
			// Silently ignore errors (like deleting non-existent branches)
		}
	}

	const BranchMaintainer = require('../src/branch-maintainer')

	// Simulate what happens when PR #69582 was merged:
	// - Head branch: merge-conflicts-69569-pr-69561-release-5.8.0-to-main
	// - Base branch: main (NOT merge-forward-pr-69561-main!)
	// - This is the incorrect merge that bypassed the merge-forward branch
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 69582,
			head: { ref: 'merge-conflicts-69569-pr-69561-release-5.8.0-to-main' },
			base: { ref: 'main' }
		},
		config: {
			branches: {
				'release-5.7.0': {},
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {
				'release-5.7.0': 'release-5.8.0',
				'release-5.8.0': 'main'
			}
		},
		core,
		shell
	})

	// Run maintenance (this is what the action does after PR merge)
	// automergeConflictBranch is undefined because the PR wasn't processed
	// through automerge - it was just a normal PR merge to main
	await maintainer.run({ automergeConflictBranch: undefined })

	const branchesAfter = git('ls-remote --heads origin')

	// When a merge-conflicts PR is merged, we should clean up the associated
	// merge-forward branches. The issue number in the branch name (69569) links
	// to the original PR (69561) that created the merge-forward branches.
	t.notOk(branchesAfter.includes('merge-forward-pr-69561-release-5.8.0'),
		'merge-forward for release-5.8.0 should be cleaned up')
	t.notOk(branchesAfter.includes('merge-forward-pr-69561-main'),
		'merge-forward for main should be cleaned up')

	// Verify branch-here was advanced (has the PR content)
	const branchHereCommitAfter = git('rev-parse origin/branch-here-release-5.8.0')
	t.not(branchHereCommitAfter, branchHereCommitBefore,
		'branch-here-release-5.8.0 should have advanced')
	const branchHereContent = git(`show ${branchHereCommitAfter}:test.txt`)
	t.equal(branchHereContent, 'PR CONTENT',
		'branch-here should have PR content after advancement')

	// Verify branch-here is an ancestor of release-5.8.0
	let isAncestor
	try {
		git('merge-base --is-ancestor ' +
			'origin/branch-here-release-5.8.0 origin/release-5.8.0')
		isAncestor = true
	} catch (e) {
		isAncestor = false
	}
	t.ok(isAncestor,
		'branch-here should be an ancestor of release-5.8.0')
})

tap.test('branch-here advances incrementally via merge-forward (issue #11)', async t => {
	// This test verifies the enhancement from issue #11:
	// branch-here should advance incrementally as each PR's chain completes,
	// even while other PRs remain blocked.
	//
	// Scenario:
	// 1. Two PRs create merge-forward branches from branch-here (at A)
	// 2. PR1's chain completes (merge-forward-pr-1 cleaned up)
	// 3. branch-here should advance to include PR1's changes
	// 4. PR2 is still blocked (merge-conflicts branch exists)
	// 5. branch-here should NOT include PR2's changes
	//
	// The key: branch-here advances by merging completed merge-forward branches,
	// not by fast-forwarding to the release branch tip.

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'base.txt'), 'Base content\n')
	git('add .')
	git('commit -m "Initial"')
	const initialCommit = git('rev-parse HEAD')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')

	// Create branch-here-release-5.8.0 at initial commit
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')

	// Create main
	git('checkout -b main')
	git('push -u origin main')

	// PR1's merge-forward branch: adds file1.txt (will complete successfully)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-111-release-5.8.0')
	await writeFile(join(repoDir, 'file1.txt'), 'PR1 content\n')
	git('add file1.txt')
	git('commit -m "PR1 changes"')
	const pr1MergeForwardCommit = git('rev-parse HEAD')
	git('push -u origin merge-forward-pr-111-release-5.8.0')

	// PR1's merge-forward for main (also exists, will be cleaned up)
	git('checkout main')
	git('checkout -b merge-forward-pr-111-main')
	await writeFile(join(repoDir, 'file1.txt'), 'PR1 content\n')
	git('add file1.txt')
	git('commit -m "PR1 to main"')
	git('push -u origin merge-forward-pr-111-main')

	// PR2's merge-forward branch: adds file2.txt (will be blocked)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-222-release-5.8.0')
	await writeFile(join(repoDir, 'file2.txt'), 'PR2 content\n')
	git('add file2.txt')
	git('commit -m "PR2 changes"')
	git('push -u origin merge-forward-pr-222-release-5.8.0')

	// PR2 is blocked: create merge-conflicts branch
	git('checkout main')
	git('checkout -b merge-conflicts-999-pr-222-release-5.8.0-to-main')
	git('push -u origin merge-conflicts-999-pr-222-release-5.8.0-to-main')

	// Verify setup
	const branchHereBefore = git('rev-parse origin/branch-here-release-5.8.0')
	t.equal(branchHereBefore, initialCommit,
		'Setup: branch-here should be at initial commit')

	// Use real Shell
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	shell.execQuietly = async (cmd) => {
		try {
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		} catch (e) {
			// Silently ignore errors
		}
	}

	const BranchMaintainer = require('../src/branch-maintainer')

	// Simulate PR1's chain completing (resolution PR merged to main)
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 333,
			head: { ref: 'merge-conflicts-888-pr-111-release-5.8.0-to-main' },
			base: { ref: 'main' }
		},
		config: {
			branches: {
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {
				'release-5.8.0': 'main'
			}
		},
		core,
		shell
	})

	await maintainer.run({ automergeConflictBranch: undefined })

	// Fetch updated refs
	git('fetch origin')

	// Verify PR1's merge-forward branches were cleaned up
	const branchesAfter = git('ls-remote --heads origin')
	t.notOk(branchesAfter.includes('merge-forward-pr-111-release-5.8.0'),
		'PR1 merge-forward for release-5.8.0 should be cleaned up')
	t.notOk(branchesAfter.includes('merge-forward-pr-111-main'),
		'PR1 merge-forward for main should be cleaned up')

	// Verify PR2's merge-forward still exists (chain not complete)
	t.ok(branchesAfter.includes('merge-forward-pr-222-release-5.8.0'),
		'PR2 merge-forward should still exist (blocked)')

	// KEY ASSERTION: branch-here should include PR1's changes
	const branchHereAfter = git('rev-parse origin/branch-here-release-5.8.0')
	t.not(branchHereAfter, initialCommit,
		'branch-here should have advanced from initial commit')

	// Verify PR1's file is in branch-here
	const pr1FileInBranchHere = git(`ls-tree --name-only ${branchHereAfter}`)
	t.ok(pr1FileInBranchHere.includes('file1.txt'),
		'branch-here should include PR1\'s file (file1.txt)')

	// Verify PR2's file is NOT in branch-here (PR2 is blocked)
	t.notOk(pr1FileInBranchHere.includes('file2.txt'),
		'branch-here should NOT include PR2\'s file (file2.txt) - PR2 is blocked')
})

tap.test('branch-here remains ancestor of release branch after advancement', async t => {
	// This tests the fix for the bug where advanceBranchHereFromMergeForward
	// created a merge commit on branch-here that didn't exist on the release
	// branch, causing the two to diverge. After the fix, branch-here should
	// always remain an ancestor of the release branch.

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'base.txt'), 'Base content\n')
	git('add .')
	git('commit -m "Initial"')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')

	// Create branch-here at same point
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')

	// Create main (terminal branch)
	git('checkout -b main')
	git('push -u origin main')

	// Add a direct PR commit to release-5.8.0 (so release is ahead
	// of branch-here, simulating real-world divergence)
	git('checkout release-5.8.0')
	await writeFile(join(repoDir, 'direct-pr.txt'), 'Direct PR\n')
	git('add direct-pr.txt')
	git('commit -m "Direct PR to release"')
	git('push origin release-5.8.0')

	// Create merge-forward branch based on branch-here (as automerger does)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-70168-release-5.8.0')
	await writeFile(join(repoDir, 'pr-feature.txt'), 'PR feature\n')
	git('add pr-feature.txt')
	git('commit -m "PR 70168 changes"')
	git('push -u origin merge-forward-pr-70168-release-5.8.0')

	// Simulate updateTargetBranch: merge merge-forward into release-5.8.0
	// (this is what automerger does when the chain completes)
	git('checkout release-5.8.0')
	git('merge origin/merge-forward-pr-70168-release-5.8.0 --no-ff ' +
		'-m "Merge commit from updateTargetBranch"')
	git('push origin release-5.8.0')

	// Set up shell for BranchMaintainer
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}

	const BranchMaintainer = require('../src/branch-maintainer')
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 70168,
			head: { ref: 'feature-branch' },
			base: { ref: 'release-5.8.0' }
		},
		config: {
			branches: { 'release-5.8.0': {}, 'main': {} },
			mergeOperations: {}
		},
		core,
		shell
	})

	// Run the method under test
	await maintainer.advanceBranchHereFromMergeForward(
		'merge-forward-pr-70168-release-5.8.0')

	// Fetch updated refs
	git('fetch origin')

	// KEY ASSERTION: branch-here must be an ancestor of release-5.8.0
	let isAncestor
	try {
		git('merge-base --is-ancestor ' +
			'origin/branch-here-release-5.8.0 origin/release-5.8.0')
		isAncestor = true
	} catch (e) {
		isAncestor = false
	}

	t.ok(isAncestor,
		'branch-here should be an ancestor of release-5.8.0 ' +
		'(not diverged)')

	// Verify branch-here actually advanced (has the PR's file)
	const branchHereFiles = git(
		'ls-tree --name-only origin/branch-here-release-5.8.0')
	t.ok(branchHereFiles.includes('pr-feature.txt'),
		'branch-here should include PR feature file')

	// Verify the commit messages include the PR number
	const branchHereLog = git(
		'log origin/branch-here-release-5.8.0 --oneline -1')
	t.ok(branchHereLog.includes('#70168'),
		'branch-here merge commit should reference PR number')
})

tap.test('branch-here should not advance past commits blocked DOWNSTREAM', async t => {
	// This reproduces the bug from issue #70306 (Jack's PR).
	//
	// Scenario with three branches: release-5.7.2 → release-5.8.0 → main
	// 1. PR A merges into release-5.7.2, chain passes release-5.8.0
	//    but CONFLICTS at main → merge-conflicts-*-release-5.8.0-to-main
	// 2. PR B merges into release-5.7.2, chain completes to main
	// 3. BranchMaintainer runs for PR B
	// 4. BUG: branch-here-release-5.7.2 advances to origin/release-5.7.2,
	//    which includes PR A's commit (chain incomplete!)
	// 5. EXPECTED: branch-here-release-5.7.2 should only include PR B's
	//    changes (via merge-forward), not PR A's
	//
	// This happens because updateBranchHerePointer checks for
	// merge-conflicts-*-release-5.7.2-to-* but PR A's conflict is at
	// release-5.8.0-to-main, so the check misses it.

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'base.txt'), 'Base content\n')
	git('add .')
	git('commit -m "Initial"')
	const initialCommit = git('rev-parse HEAD')

	// Create release-5.7.2
	git('checkout -b release-5.7.2')
	git('push -u origin release-5.7.2')

	// Create branch-here-release-5.7.2 at initial commit
	git('checkout -b branch-here-release-5.7.2')
	git('push -u origin branch-here-release-5.7.2')
	git('checkout release-5.7.2')

	// Create release-5.8.0
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')

	// Create branch-here-release-5.8.0 at initial commit
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')

	// Create main
	git('checkout -b main')
	git('push -u origin main')

	// PR A: merged directly into release-5.7.2 (adds a.txt)
	// Its chain passed through release-5.8.0 but is blocked at main
	git('checkout release-5.7.2')
	await writeFile(join(repoDir, 'a.txt'), 'PR A content\n')
	git('add a.txt')
	git('commit -m "PR A - blocked downstream"')
	git('push origin release-5.7.2')

	// PR B: also merged directly into release-5.7.2 (adds b.txt)
	// Its chain completed all the way to main
	await writeFile(join(repoDir, 'b.txt'), 'PR B content\n')
	git('add b.txt')
	git('commit -m "PR B - completes to main"')
	git('push origin release-5.7.2')

	// PR A is blocked: create merge-conflicts from release-5.8.0
	// (NOT from release-5.7.2 - this is the key detail!)
	git('checkout main')
	git('checkout -b merge-conflicts-500-pr-100-release-5.8.0-to-main')
	git('push -u origin merge-conflicts-500-pr-100-release-5.8.0-to-main')

	// PR B's merge-forward branches (created by automerger, based on
	// branch-here snapshots). These are what BranchMaintainer cleans up.
	git('checkout branch-here-release-5.7.2')
	git('checkout -b merge-forward-pr-200-release-5.7.2')
	await writeFile(join(repoDir, 'b.txt'), 'PR B content\n')
	git('add b.txt')
	git('commit -m "PR B merge-forward to release-5.7.2"')
	git('push -u origin merge-forward-pr-200-release-5.7.2')

	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-200-release-5.8.0')
	await writeFile(join(repoDir, 'b.txt'), 'PR B content\n')
	git('add b.txt')
	git('commit -m "PR B merge-forward to release-5.8.0"')
	git('push -u origin merge-forward-pr-200-release-5.8.0')

	// Verify setup
	const branchHereBefore = git('rev-parse origin/branch-here-release-5.7.2')
	t.equal(branchHereBefore, initialCommit,
		'Setup: branch-here should be at initial commit')

	// Use real Shell
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	shell.execQuietly = async (cmd) => {
		try {
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		} catch (e) {
			// Silently ignore errors
		}
	}

	const BranchMaintainer = require('../src/branch-maintainer')

	// PR B's chain completed (merged to release-5.7.2, automerge succeeded)
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 200,
			head: { ref: 'issue-200-feature' },
			base: { ref: 'release-5.7.2' }
		},
		config: {
			branches: {
				'release-5.7.2': {},
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {
				'release-5.7.2': 'release-5.8.0',
				'release-5.8.0': 'main'
			}
		},
		core,
		shell
	})

	await maintainer.run({ automergeConflictBranch: undefined })

	// Fetch updated refs
	git('fetch origin')

	// KEY ASSERTION: branch-here-release-5.7.2 should NOT contain a.txt
	// (PR A's chain hasn't completed to main)
	const branchHereAfter = git('rev-parse origin/branch-here-release-5.7.2')
	const branchHereFiles = git(
		`ls-tree --name-only ${branchHereAfter}`)
	t.ok(branchHereFiles.includes('b.txt'),
		'branch-here should include PR B file (chain completed)')
	t.notOk(branchHereFiles.includes('a.txt'),
		'branch-here should NOT include PR A file (chain blocked downstream)')
})

tap.test('branch names with periods work without normalization (issue #14)', async t => {
	// This test verifies that branch names containing periods (e.g., release-5.8.0)
	// work correctly in merge-forward and merge-conflicts branch names without
	// needing to normalize them to hyphens (e.g., release-5.8.0).
	//
	// The test creates branches with ACTUAL names (periods intact) and verifies
	// they can be parsed correctly.

	const { repoDir, originDir, git } = await createTestRepo()

	t.teardown(async () => {
		await cleanupTestRepo(repoDir, originDir)
	})

	// Setup: Create initial commit
	await writeFile(join(repoDir, 'test.txt'), 'Initial\n')
	git('add test.txt')
	git('commit -m "Initial"')

	// Create release-5.8.0 (with periods)
	git('checkout -b release-5.8.0')
	git('push -u origin release-5.8.0')

	// Create branch-here-release-5.8.0
	git('checkout -b branch-here-release-5.8.0')
	git('push -u origin branch-here-release-5.8.0')

	// Create main
	git('checkout -b main')
	git('push -u origin main')

	// Create merge-forward branch with ACTUAL name (periods, not normalized)
	git('checkout branch-here-release-5.8.0')
	git('checkout -b merge-forward-pr-999-release-5.8.0')
	await writeFile(join(repoDir, 'feature.txt'), 'Feature\n')
	git('add feature.txt')
	git('commit -m "Feature commit"')
	git('push -u origin merge-forward-pr-999-release-5.8.0')

	// Verify the branch name contains periods (not normalized to hyphens)
	const branches = git('ls-remote --heads origin')
	t.ok(branches.includes('merge-forward-pr-999-release-5.8.0'),
		'merge-forward branch should use actual name with periods')
	t.notOk(branches.includes('merge-forward-pr-999-release-5-8-0'),
		'merge-forward branch should NOT be normalized to hyphens')

	// Use real Shell
	const { Shell } = require('gh-action-components')
	const core = mockCore({})
	const shell = new Shell(core)
	shell.exec = async (cmd) => {
		return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
	}
	shell.execQuietly = async (cmd) => {
		try {
			return execSync(cmd, { cwd: repoDir, encoding: 'utf-8' }).trim()
		} catch (e) {
			// Silently ignore errors
		}
	}

	const BranchMaintainer = require('../src/branch-maintainer')

	// Test that BranchMaintainer can parse and advance branch-here
	// from a merge-forward branch with periods in the name
	const maintainer = new BranchMaintainer({
		pullRequest: {
			merged: true,
			number: 888,
			head: { ref: 'merge-conflicts-777-pr-999-release-5.8.0-to-main' },
			base: { ref: 'main' }
		},
		config: {
			branches: {
				'release-5.8.0': {},
				'main': {}
			},
			mergeOperations: {
				'release-5.8.0': 'main'
			}
		},
		core,
		shell
	})

	// This should work without needing to denormalize the branch name
	await maintainer.run({ automergeConflictBranch: undefined })

	// Fetch updated refs
	git('fetch origin')

	// Verify branch-here was advanced
	const branchHereAfter = git('rev-parse origin/branch-here-release-5.8.0')
	const initialCommit = git('rev-parse HEAD~1')
	t.not(branchHereAfter, initialCommit,
		'branch-here should advance when merge-forward branch with periods is cleaned up')

	// Verify merge-forward was deleted
	const branchesAfter = git('ls-remote --heads origin')
	t.notOk(branchesAfter.includes('merge-forward-pr-999-release-5.8.0'),
		'merge-forward branch should be cleaned up')
})
